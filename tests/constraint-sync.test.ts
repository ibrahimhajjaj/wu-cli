import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";
import { parse as parseYaml } from "yaml";
import type { RemoteConfig } from "../src/config/schema.js";
// Type-only import: erased at runtime, so it cannot load the module before
// WU_HOME is set below.
import type { SshExec } from "../src/core/constraint-sync.js";

// Redirect WU_HOME before importing anything that freezes paths from it.
const home = mkdtempSync(join(tmpdir(), "wu-csync-"));
process.env.WU_HOME = home;
mkdirSync(join(home, "auth"), { recursive: true });

let sync: typeof import("../src/core/constraint-sync.js");
let schema: typeof import("../src/config/schema.js");

before(async () => {
  schema = await import("../src/config/schema.js");
  sync = await import("../src/core/constraint-sync.js");
});

after(() => {
  rmSync(home, { recursive: true, force: true });
});

// The "remote" is a directory and a shell. Running the real command strings
// against it exercises the actual write protocol - heredoc, temp file, move,
// read-back - without a network. $HOME points at the fake box so remotePath's
// "$HOME" expansion lands there.
let remoteDir: string;

function shellExec(): SshExec {
  return async (_r: RemoteConfig, cmd: string) => {
    try {
      const stdout = execFileSync("/bin/sh", ["-c", cmd], {
        env: { ...process.env, HOME: remoteDir },
        encoding: "utf-8",
      });
      return { stdout, stderr: "", exitCode: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.status ?? 1 };
    }
  };
}

function remoteConfigPath() {
  return join(remoteDir, ".wu", "config.yaml");
}

function remoteWuDir() {
  return join(remoteDir, ".wu");
}

function localConfig(chats: Record<string, { mode: "full" | "read" | "none" }>) {
  return schema.WuConfigSchema.parse({
    constraints: { default: "none", chats },
    remotes: { vps: { host: "example.invalid", wu_home: "~/.wu" } },
    default_remote: "vps",
  });
}

function landedOnRemote() {
  return schema.WuConfigSchema.parse(parseYaml(readFileSync(remoteConfigPath(), "utf-8")));
}

// Spelled out rather than imported: importing config/paths.js at the top of this
// file would freeze WU_HOME before the redirect above. Spelling it out also means
// renaming the constant fails this test instead of quietly disabling the guard.
const NO_PROPAGATE_ENV = "WU_NO_PROPAGATE";

beforeEach(() => {
  remoteDir = mkdtempSync(join(tmpdir(), "wu-csync-box-"));
  mkdirSync(remoteWuDir(), { recursive: true });
  delete process.env[NO_PROPAGATE_ENV];
});

describe("propagateConstraints", () => {
  it("applies the constraints on the collector and preserves its other settings", async () => {
    // The box has its own db path and discovery setting; both must survive.
    writeFileSync(
      remoteConfigPath(),
      "db:\n  path: /var/lib/wu/custom.db\nwhatsapp:\n  group_discovery: false\nconstraints:\n  default: none\n  chats: {}\n"
    );

    const result = await sync.propagateConstraints(
      localConfig({ "new@g.us": { mode: "read" } }),
      shellExec()
    );
    assert.equal(result.status, "pushed");
    assert.equal(result.remote, "vps");

    const landed = landedOnRemote();
    assert.equal(landed.constraints?.chats["new@g.us"]?.mode, "read", "constraint applied");
    assert.equal(landed.db.path, "/var/lib/wu/custom.db", "box's own db path preserved");
    assert.equal(landed.whatsapp.group_discovery, false, "box's own setting preserved");
  });

  it("creates the config when the collector has none yet", async () => {
    const result = await sync.propagateConstraints(
      localConfig({ "a@g.us": { mode: "full" } }),
      shellExec()
    );
    assert.equal(result.status, "pushed");
    assert.ok(existsSync(remoteConfigPath()));
    assert.equal(landedOnRemote().constraints?.chats["a@g.us"]?.mode, "full");
  });

  it("refuses to overwrite a config it could not parse", async () => {
    // Replacing an unreadable config with defaults would silently drop the
    // box's real settings, which is worse than not applying the constraint.
    const garbage = "constraints:\n  default: [unclosed\n";
    writeFileSync(remoteConfigPath(), garbage);

    const result = await sync.propagateConstraints(
      localConfig({ "b@g.us": { mode: "read" } }),
      shellExec()
    );
    assert.equal(result.status, "failed");
    assert.match(result.error!, /did not parse/);
    assert.equal(readFileSync(remoteConfigPath(), "utf-8"), garbage, "left untouched");
  });

  it("reports failure and writes nothing when the connection is down", async () => {
    writeFileSync(remoteConfigPath(), "constraints:\n  default: none\n  chats: {}\n");
    const before = readFileSync(remoteConfigPath(), "utf-8");
    const deadExec: SshExec = async () => ({
      stdout: "",
      stderr: "ssh: connect to host port 22: Network is unreachable",
      exitCode: 255,
    });

    const result = await sync.propagateConstraints(
      localConfig({ "c@g.us": { mode: "read" } }),
      deadExec
    );
    assert.equal(result.status, "failed");
    assert.match(result.error!, /unreachable/);
    assert.ok(result.hint!.includes("remote setup"), "tells the caller how to finish by hand");
    assert.equal(readFileSync(remoteConfigPath(), "utf-8"), before, "collector untouched");
  });

  it("never leaves a half-written config live when the write fails", async () => {
    writeFileSync(remoteConfigPath(), "constraints:\n  default: none\n  chats: {}\n");
    const real = shellExec();
    let call = 0;
    const failWrite: SshExec = async (r, cmd) => {
      call++;
      if (call === 1) return real(r, cmd); // let the read succeed
      return { stdout: "", stderr: "no space left on device", exitCode: 1 };
    };

    const result = await sync.propagateConstraints(
      localConfig({ "d@g.us": { mode: "read" } }),
      failWrite
    );
    assert.equal(result.status, "failed");
    const after = readFileSync(remoteConfigPath(), "utf-8");
    assert.ok(!after.includes("d@g.us"), "the live config never saw the partial write");
  });

  it("catches a write that lands but does not match what was sent", async () => {
    writeFileSync(remoteConfigPath(), "constraints:\n  default: none\n  chats: {}\n");
    const real = shellExec();
    let call = 0;
    // Read and write for real, then lie on the read-back.
    const lyingVerify: SshExec = async (r, cmd) => {
      call++;
      if (call <= 2) return real(r, cmd);
      return { stdout: "constraints:\n  default: none\n  chats: {}\n", stderr: "", exitCode: 0 };
    };

    const result = await sync.propagateConstraints(
      localConfig({ "e@g.us": { mode: "read" } }),
      lyingVerify
    );
    assert.equal(result.status, "failed");
    assert.match(result.error!, /do not match/);
  });

  it("leaves no temp files in the collector's wu directory", async () => {
    await sync.propagateConstraints(localConfig({ "f@g.us": { mode: "read" } }), shellExec());
    const leftovers = readdirSync(remoteWuDir()).filter((f) => f.includes("wu-tmp"));
    assert.deepEqual(leftovers, [], "temp file was moved into place, not left behind");
  });

  it("propagates a removal, not just an addition", async () => {
    writeFileSync(
      remoteConfigPath(),
      "constraints:\n  default: none\n  chats:\n    gone@g.us:\n      mode: read\n"
    );
    const result = await sync.propagateConstraints(localConfig({}), shellExec());
    assert.equal(result.status, "pushed");
    assert.equal(landedOnRemote().constraints?.chats["gone@g.us"], undefined);
  });

  it("survives wildcard keys and non-ascii names through the shell heredoc", async () => {
    // The real config carries wildcard rules and Arabic / emoji group names, and
    // the payload travels through a shell heredoc to get there.
    const cfg = schema.WuConfigSchema.parse({
      constraints: {
        default: "none",
        chats: {
          "*@g.us": { mode: "read" },
          "120363409042876290@g.us": { mode: "read" },
          "'quoted$var`tick@g.us": { mode: "full" },
        },
      },
      remotes: { vps: { host: "example.invalid", wu_home: "~/.wu" } },
      default_remote: "vps",
    });

    const result = await sync.propagateConstraints(cfg, shellExec());
    assert.equal(result.status, "pushed", result.error ?? "");

    const landed = landedOnRemote();
    assert.equal(landed.constraints?.chats["*@g.us"]?.mode, "read", "wildcard survived");
    assert.equal(landed.constraints?.chats["120363409042876290@g.us"]?.mode, "read");
    assert.equal(
      landed.constraints?.chats["'quoted$var`tick@g.us"]?.mode,
      "full",
      "shell metacharacters in a jid are not interpreted"
    );
  });

  it("keeps the collector's comments and any keys this version does not know", async () => {
    // Re-serializing our own schema over the box's file would strip comments and
    // silently delete keys a newer wu on the box wrote. That is the same
    // "wiped the box's settings" hazard, just moved to version skew.
    writeFileSync(
      remoteConfigPath(),
      [
        "# collector box - do not edit by hand",
        "db:",
        "  path: /var/lib/wu/custom.db",
        "daemon_experimental: keep-me",
        "constraints:",
        "  default: none",
        "  chats: {}",
        "",
      ].join("\n")
    );

    const result = await sync.propagateConstraints(
      localConfig({ "kept@g.us": { mode: "read" } }),
      shellExec()
    );
    assert.equal(result.status, "pushed", result.error ?? "");

    const raw = readFileSync(remoteConfigPath(), "utf-8");
    assert.match(raw, /# collector box - do not edit by hand/, "comment survived");
    assert.match(raw, /daemon_experimental: keep-me/, "unknown key survived");
    assert.match(raw, /custom\.db/, "existing setting survived");
    assert.equal(landedOnRemote().constraints?.chats["kept@g.us"]?.mode, "read");
  });

  it("fails loudly when several remotes exist and none is the default", async () => {
    // Silently skipping here would reinstate exactly the bug this module fixes.
    const ambiguous = schema.WuConfigSchema.parse({
      constraints: { default: "none", chats: { "x@g.us": { mode: "read" } } },
      remotes: {
        vps: { host: "a.invalid", wu_home: "~/.wu" },
        other: { host: "b.invalid", wu_home: "~/.wu" },
      },
    });

    const result = await sync.propagateConstraints(ambiguous, shellExec());
    assert.equal(result.status, "failed");
    assert.match(result.error!, /which remote collects/);
    assert.match(result.hint!, /remote default/);
  });

  it("skips when no remote is configured", async () => {
    const localOnly = schema.WuConfigSchema.parse({ constraints: { default: "none", chats: {} } });
    const result = await sync.propagateConstraints(localOnly, shellExec());
    assert.equal(result.status, "skipped");
    assert.match(result.reason!, /no remote configured/);
  });

  it("skips when already running on the collector, so it cannot loop", async () => {
    process.env[NO_PROPAGATE_ENV] = "1";
    const result = await sync.propagateConstraints(
      localConfig({ "g@g.us": { mode: "read" } }),
      shellExec()
    );
    assert.equal(result.status, "skipped");
    assert.match(result.reason!, /on the collector/);
  });
});

describe("saveConstraints", () => {
  it("keeps the local write even when the collector cannot be reached", async () => {
    const deadExec: SshExec = async () => ({ stdout: "", stderr: "unreachable", exitCode: 255 });
    const cfg = localConfig({ "kept@g.us": { mode: "full" } });

    const result = await sync.saveConstraints(cfg, deadExec);
    assert.equal(result.status, "failed");
    // The operator's own config still records the intent, so nothing is lost.
    assert.equal(schema.loadConfig().constraints?.chats["kept@g.us"]?.mode, "full");
  });

  it("two writes landing together leave the collector agreeing with the laptop", async () => {
    // The MCP server does not await one tool handler before starting the next, so
    // an agent setting two constraints in a turn overlaps them. Both pushes must
    // end up sending the merged on-disk state, or the collector keeps whichever
    // arrived last and both calls still claim success.
    const slowThenFast = (() => {
      let n = 0;
      const real = shellExec();
      return (async (r, cmd) => {
        n++;
        // Delay the first caller's writes so the second overtakes it.
        if (n <= 3) await new Promise((res) => setTimeout(res, 40));
        return real(r, cmd);
      }) as SshExec;
    })();

    schema.saveConfig(localConfig({}));

    const first = (async () => {
      const cfg = schema.loadConfig();
      cfg.constraints!.chats["A@g.us"] = { mode: "read" };
      return sync.saveConstraints(cfg, slowThenFast);
    })();
    const second = (async () => {
      const cfg = schema.loadConfig();
      cfg.constraints!.chats["B@g.us"] = { mode: "read" };
      return sync.saveConstraints(cfg, slowThenFast);
    })();
    const [a, b] = await Promise.all([first, second]);

    assert.equal(a.status, "pushed", a.error ?? "");
    assert.equal(b.status, "pushed", b.error ?? "");

    const laptop = Object.keys(schema.loadConfig().constraints!.chats).sort();
    const collector = Object.keys(landedOnRemote().constraints!.chats).sort();
    assert.deepEqual(collector, laptop, "collector agrees with the laptop");
  });

  it("reports the collector as updated on the happy path", async () => {
    const result = await sync.saveConstraints(
      localConfig({ "ok@g.us": { mode: "read" } }),
      shellExec()
    );
    assert.equal(result.status, "pushed");
    assert.equal(landedOnRemote().constraints?.chats["ok@g.us"]?.mode, "read");
  });
});

describe("describePropagation", () => {
  it("says nothing when there was nothing to do", () => {
    assert.equal(sync.describePropagation({ status: "skipped", reason: "x" }), "");
  });

  it("names the remote on success and the recovery command on failure", () => {
    assert.match(sync.describePropagation({ status: "pushed", remote: "vps" }), /vps/);
    const failed = sync.describePropagation({
      status: "failed",
      remote: "vps",
      error: "boom",
      hint: "wu remote setup vps --push",
    });
    assert.match(failed, /NOT applied/);
    assert.match(failed, /wu remote setup vps --push/);
  });
});
