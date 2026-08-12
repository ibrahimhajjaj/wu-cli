import { parseDocument, stringify as stringifyYaml } from "yaml";
import { isDeepStrictEqual } from "node:util";
import {
  WuConfigSchema,
  saveConfig,
  loadConfig,
  type WuConfig,
  type RemoteConfig,
} from "../config/schema.js";
import { NO_PROPAGATE_ENV } from "../config/paths.js";
import { getDefaultRemote, sshRawExec, remotePath } from "./remote.js";
import { createChildLogger } from "../config/logger.js";

const logger = createChildLogger("constraint-sync");

// Marker the read probe prints when the remote has no config yet, so an absent
// file is distinguishable from a failed read. Overwriting a config we could not
// read would silently wipe the box's other settings.
const ABSENT = "__WU_CONFIG_ABSENT__";
const HEREDOC = "WU_CONSTRAINTS_EOF";

/** The one call this module makes to the outside world. Injectable so the write
 * protocol (heredoc, temp file, move, read-back) can be tested against a
 * directory instead of a real host. */
export type SshExec = (
  remote: RemoteConfig,
  command: string
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export interface PropagateResult {
  /** pushed = the collector has it; skipped = nothing to do; failed = local write kept, collector does not have it. */
  status: "pushed" | "skipped" | "failed";
  remote?: string;
  reason?: string;
  error?: string;
  /** The command that finishes the job by hand when status is "failed". */
  hint?: string;
}

// Pushes are serialized process-wide. Two constraint writes in flight at once
// would otherwise race on the collector's file and both report success, leaving
// the laptop and the collector disagreeing - the exact failure this module
// exists to prevent. The MCP server dispatches tool calls without awaiting the
// previous handler, so an agent setting two constraints in one turn hits this.
let pushChain: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = pushChain.then(fn, fn);
  pushChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * Copy the local constraint block onto the default remote's config.
 *
 * Constraints decide what the collector stores, and the collector reads its own
 * config file - so a write that only lands locally leaves the daemon enforcing
 * the old rules. It keeps updating chat metadata (discovery is not gated) while
 * dropping message bodies, which looks identical to a broken daemon.
 *
 * Only the constraints key is replaced. The rest of the document is carried
 * through untouched, comments and all, so a box running a newer wu does not lose
 * keys this version has never heard of.
 */
export async function propagateConstraints(
  config: WuConfig,
  exec: SshExec = sshRawExec
): Promise<PropagateResult> {
  if (process.env[NO_PROPAGATE_ENV]) {
    return { status: "skipped", reason: "running on the collector" };
  }
  if (!config.constraints) return { status: "skipped", reason: "no local constraints to push" };

  const names = config.remotes ? Object.keys(config.remotes) : [];
  if (names.length === 0) return { status: "skipped", reason: "no remote configured" };

  const target = getDefaultRemote(config);
  if (!target) {
    // Remotes exist but none is selected, so we cannot know which box collects.
    // Staying quiet here would silently reinstate the bug this module fixes.
    return {
      status: "failed",
      error: `cannot tell which remote collects (${names.length} configured, no default_remote set)`,
      hint: `wu remote default <${names.join("|")}>`,
    };
  }

  return pushConstraintsTo(target.name, target.remote, config, exec);
}

/** Push `config`'s constraints onto one named remote. Used by the automatic
 * propagation above and by `wu remote setup <name> --push`. */
export async function pushConstraintsTo(
  name: string,
  remote: RemoteConfig,
  config: WuConfig,
  exec: SshExec = sshRawExec
): Promise<PropagateResult> {
  if (!config.constraints) return { status: "skipped", reason: "no local constraints to push" };
  return serialized(() => pushOnce(name, remote, config, exec));
}

async function pushOnce(
  name: string,
  remote: RemoteConfig,
  config: WuConfig,
  exec: SshExec
): Promise<PropagateResult> {
  const wanted = config.constraints!;
  const hint = `wu remote setup ${name} --push`;
  const path = remotePath(`${remote.wu_home.replace(/\/+$/, "")}/config.yaml`);

  // 1. Read what is there now. A non-zero exit means the box or the connection
  //    is the problem, and nothing may be written on top of that.
  const read = await exec(remote, `if [ -f ${path} ]; then cat ${path}; else printf '${ABSENT}'; fi`);
  if (read.exitCode !== 0) {
    return {
      status: "failed",
      remote: name,
      error: read.stderr.trim() || `ssh exited ${read.exitCode}`,
      hint,
    };
  }

  // 2. Edit the document in place rather than re-serializing our own schema over
  //    it. Round-tripping through the schema would strip comments, drop keys this
  //    version does not know about, and bake in our defaults - the same "wiped
  //    the box's settings" hazard, just moved to version skew.
  let doc;
  if (read.stdout.trim() === ABSENT) {
    doc = parseDocument(stringifyYaml({ constraints: wanted }));
  } else {
    doc = parseDocument(read.stdout);
    if (doc.errors.length > 0) {
      return {
        status: "failed",
        remote: name,
        error: `remote config did not parse, leaving it untouched: ${doc.errors[0].message}`,
        hint,
      };
    }
    // Validate what is on the box before touching it, but keep the document, not
    // the parsed object.
    try {
      WuConfigSchema.parse(doc.toJS() ?? {});
    } catch (err) {
      return {
        status: "failed",
        remote: name,
        error: `remote config is not valid, leaving it untouched: ${(err as Error).message}`,
        hint,
      };
    }
    doc.setIn(["constraints"], wanted);
  }

  const yaml = String(doc);
  if (yaml.split("\n").some((line) => line.trim() === HEREDOC)) {
    return { status: "failed", remote: name, error: "config contains the heredoc marker", hint };
  }

  // 3. Write beside the target, then move it into place. The daemon watches the
  //    directory, so the move is what wakes it, and a dropped connection can
  //    never leave a half-written config for it to reload.
  const write = await exec(
    remote,
    [
      `p=${path}`,
      `mkdir -p "$(dirname "$p")"`,
      `t="$p.wu-tmp.$$"`,
      "umask 077",
      `cat > "$t" << '${HEREDOC}'`,
      yaml.endsWith("\n") ? yaml.slice(0, -1) : yaml,
      HEREDOC,
      `mv -f "$t" "$p"`,
    ].join("\n")
  );
  if (write.exitCode !== 0) {
    return {
      status: "failed",
      remote: name,
      error: write.stderr.trim() || `ssh exited ${write.exitCode}`,
      hint,
    };
  }

  // 4. Read back and confirm the collector holds exactly what we sent, rather
  //    than trusting a zero exit code.
  const verify = await exec(remote, `cat ${path}`);
  if (verify.exitCode !== 0) {
    return { status: "failed", remote: name, error: "wrote the config but could not read it back", hint };
  }
  try {
    const landed = WuConfigSchema.parse(parseDocument(verify.stdout).toJS() ?? {});
    if (!isDeepStrictEqual(landed.constraints, wanted)) {
      return {
        status: "failed",
        remote: name,
        error: "the constraints on the collector do not match what was sent",
        hint,
      };
    }
  } catch (err) {
    return { status: "failed", remote: name, error: `could not verify the written config: ${(err as Error).message}`, hint };
  }

  logger.debug({ remote: name }, "Propagated constraints to the collector");
  return { status: "pushed", remote: name };
}

/**
 * Persist a constraint change and get it to the collector in one step.
 *
 * The push reads the just-saved file rather than the caller's in-memory copy, so
 * two writes landing together both send the same merged state and the order the
 * collector applies them in stops mattering.
 *
 * Failing to reach the collector never fails the local write - the caller
 * reports it so the change is not silently half-applied.
 */
export async function saveConstraints(
  config: WuConfig,
  exec: SshExec = sshRawExec
): Promise<PropagateResult> {
  saveConfig(config);
  try {
    return await propagateConstraints(loadConfig(), exec);
  } catch (err) {
    const target = getDefaultRemote(config);
    return {
      status: "failed",
      remote: target?.name,
      error: (err as Error).message,
      hint: target ? `wu remote setup ${target.name} --push` : undefined,
    };
  }
}

/** One line describing what happened, for the CLI. Empty when nothing was needed. */
export function describePropagation(result: PropagateResult): string {
  if (result.status === "pushed") return `  → also applied on ${result.remote}`;
  if (result.status === "failed") {
    return `  ⚠ saved locally but NOT applied on ${result.remote ?? "the collector"}: ${result.error}\n    the collector keeps using its old rules until you run: ${result.hint}`;
  }
  return "";
}
