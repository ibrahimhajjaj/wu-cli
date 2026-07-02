import { Command } from "commander";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { AUTH_DIR, DB_PATH } from "../config/paths.js";
import { isLocked } from "../core/lock.js";
import { readDaemonState, type DaemonStateData } from "../core/daemon-state.js";
import { loadConfig, type WuConfig } from "../config/schema.js";
import { getDb } from "../db/database.js";
import { enrichStatus } from "../core/enrich.js";
import { checkRemoteHealth, getDefaultRemote } from "../core/remote.js";
import { EXIT_SUCCESS, EXIT_GENERAL_ERROR } from "./exit-codes.js";

// wu doctor rolls up the health signals that already exist scattered across
// `wu status`, `wu enrich status`, and the store/lock/remote modules into one
// fatal-vs-advisory report. It never repairs anything - only prints a fix hint
// (e.g. "run `wu db reindex`") the operator can choose to run. See
// plans/notes/015-wu-doctor-design.md for the per-check rationale.

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface DoctorSummary {
  overall: "ok" | "warn" | "fail";
  exitCode: number;
}

// Pure aggregation: any `fail` makes the whole run fatal (non-zero exit, so
// this is cron/CI-able); `skip` never affects the outcome.
export function summarize(checks: DoctorCheck[]): DoctorSummary {
  const overall = checks.some((c) => c.status === "fail")
    ? "fail"
    : checks.some((c) => c.status === "warn")
      ? "warn"
      : "ok";
  return { overall, exitCode: overall === "fail" ? EXIT_GENERAL_ERROR : EXIT_SUCCESS };
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function fmtAge(seconds: number | null): string {
  if (seconds == null) return "never";
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  return `${(seconds / 3600).toFixed(1)}h ago`;
}

function guard(name: string, fn: () => DoctorCheck): DoctorCheck {
  try {
    return fn();
  } catch (err) {
    return { name, status: "fail", detail: `check crashed: ${(err as Error).message}` };
  }
}

async function guardAsync(name: string, fn: () => Promise<DoctorCheck>): Promise<DoctorCheck> {
  try {
    return await fn();
  } catch (err) {
    return { name, status: "fail", detail: `check crashed: ${(err as Error).message}` };
  }
}

// --- Individual checks ---

function checkAuth(): DoctorCheck {
  const credsPath = join(AUTH_DIR, "creds.json");
  if (!existsSync(credsPath)) {
    return { name: "auth", status: "fail", detail: "not authenticated", fix: "wu login" };
  }
  try {
    const creds = JSON.parse(readFileSync(credsPath, "utf-8"));
    const phone = creds.me?.id?.split(":")[0] || creds.me?.id || "unknown";
    return { name: "auth", status: "ok", detail: `authenticated as ${phone}` };
  } catch {
    return {
      name: "auth",
      status: "fail",
      detail: "creds.json exists but could not be parsed",
      fix: "wu logout && wu login",
    };
  }
}

function checkDaemon(authenticated: boolean, locked: boolean, pid?: number): DoctorCheck {
  if (!authenticated) {
    return { name: "daemon", status: "skip", detail: "not authenticated yet" };
  }
  if (locked) {
    return { name: "daemon", status: "ok", detail: `running (pid ${pid})` };
  }
  return {
    name: "daemon",
    status: "fail",
    detail: "not running - nothing is being collected",
    fix: "wu daemon (foreground) or wu daemon install (systemd background service)",
  };
}

// Composes the same heartbeat status.ts reads, with the same staleness rule
// (a socket that reports "open" but has gone silent past the watchdog window).
function checkStream(
  locked: boolean,
  data: DaemonStateData | null,
  staleSeconds: number
): DoctorCheck {
  if (!locked) {
    return { name: "stream", status: "skip", detail: "daemon not running" };
  }
  if (!data) {
    return {
      name: "stream",
      status: "warn",
      detail: "no heartbeat file yet (daemon predates heartbeat, or just started)",
      fix: "restart the daemon if this persists",
    };
  }

  const t = now();
  const streamAge = data.last_event_at == null ? null : t - data.last_event_at;
  const stale =
    data.connection === "open" &&
    staleSeconds > 0 &&
    streamAge != null &&
    streamAge >= staleSeconds;

  if (data.connection === "close") {
    const disconnectAge = data.last_disconnect_at == null ? null : t - data.last_disconnect_at;
    return {
      name: "stream",
      status: "fail",
      detail: `socket closed, last disconnect ${fmtAge(disconnectAge)}`,
      fix: "check `wu daemon logs`; it should auto-reconnect - restart the daemon if it doesn't",
    };
  }
  if (stale) {
    return {
      name: "stream",
      status: "fail",
      detail: `socket reports open but no events for ${streamAge}s (watchdog threshold ${staleSeconds}s)`,
      fix: "the watchdog should restart it within a minute; check `wu daemon logs` if it doesn't",
    };
  }
  if (data.connection === "connecting") {
    return { name: "stream", status: "warn", detail: "reconnecting" };
  }
  return { name: "stream", status: "ok", detail: `open, last event ${fmtAge(streamAge)}` };
}

// A write failure within this window means ingestion is currently degraded.
// Mirrors status.ts's STORE_ERROR_FRESH_SECONDS.
const STORE_ERROR_FRESH_SECONDS = 600;

// getStoreHealth() in src/core/store.ts is per-process in-memory state - it
// only reflects writes made by the calling process. `wu doctor` never writes
// messages itself, so calling it directly would always read as empty. The
// daemon folds its own getStoreHealth() into the heartbeat file every watchdog
// tick (DaemonState.recordStoreHealth), so we read the persisted copy from
// there instead, the same signal `wu status` composes.
function checkStoreWrite(data: DaemonStateData | null): DoctorCheck {
  if (!data) {
    return {
      name: "store_write",
      status: "skip",
      detail: "no heartbeat file (daemon not running or predates heartbeat)",
    };
  }
  const t = now();
  const fresh =
    data.last_store_error_at != null && t - data.last_store_error_at < STORE_ERROR_FRESH_SECONDS;
  const rebuiltNote =
    data.fts_rebuilds > 0
      ? ` (${data.fts_rebuilds} auto-rebuild${data.fts_rebuilds === 1 ? "" : "s"} so far)`
      : "";
  if (fresh) {
    return {
      name: "store_write",
      status: "fail",
      detail: `write failing as of ${fmtAge(t - data.last_store_error_at!)}: ${data.last_store_error}${rebuiltNote}`,
      fix: "check disk space/permissions; if FTS-related, run `wu db reindex`",
    };
  }
  return { name: "store_write", status: "ok", detail: `no recent write errors${rebuiltNote}` };
}

function resolveDbPath(config: WuConfig): string {
  return config.db.path || DB_PATH;
}

// FTS5's 'integrity-check' special command scans the index against the
// content table and raises if they disagree, without modifying either - the
// read-only counterpart to the 'rebuild' command store.ts uses for recovery.
// Only run it once a database actually exists so `wu doctor` never causes the
// lazy schema-init in getDb() to create one on a machine that never logged in.
function checkFtsIntegrity(config: WuConfig): DoctorCheck {
  const dbPath = resolveDbPath(config);
  if (!existsSync(dbPath)) {
    return { name: "fts_integrity", status: "skip", detail: "no database yet" };
  }
  try {
    const db = getDb();
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')");
    return { name: "fts_integrity", status: "ok", detail: "search index verified" };
  } catch (err) {
    return {
      name: "fts_integrity",
      status: "warn",
      detail: `search index check failed: ${(err as Error).message}`,
      fix: "wu db reindex",
    };
  }
}

// Always advisory: an unavailable enrichment backend degrades a single
// optional feature (transcription/OCR), not ingestion.
function checkEnrich(config: WuConfig): DoctorCheck[] {
  return enrichStatus(config.enrich).map(
    (s): DoctorCheck => ({
      name: `enrich_${s.capability}`,
      status: s.available ? "ok" : "warn",
      detail: s.detail,
      fix: s.available ? undefined : s.enable_hint || undefined,
    })
  );
}

// Off by default (adds SSH round-trip latency); opt in with --remote. Remote
// reachability never fails the local run - it's a degraded-optional sync
// source, not the thing `wu doctor` is diagnosing.
async function checkRemote(config: WuConfig, includeRemote: boolean): Promise<DoctorCheck> {
  if (!includeRemote) {
    return { name: "remote", status: "skip", detail: "not probed (pass --remote to check)" };
  }
  const def = getDefaultRemote(config);
  if (!def) {
    return { name: "remote", status: "skip", detail: "no remote configured" };
  }
  const health = await checkRemoteHealth(def.remote);
  if (!health.reachable) {
    return {
      name: "remote",
      status: "warn",
      detail: `${def.name} (${def.remote.host}) unreachable`,
      fix: "check SSH connectivity / host config",
    };
  }
  if (!health.wuInstalled) {
    return {
      name: "remote",
      status: "warn",
      detail: `${def.name} reachable but wu is not installed`,
      fix: `install wu on ${def.remote.host}`,
    };
  }
  if (!health.daemonRunning) {
    return {
      name: "remote",
      status: "warn",
      detail: `${def.name} reachable, wu installed, daemon not running`,
      fix: `ssh into ${def.remote.host} and run wu daemon install`,
    };
  }
  return { name: "remote", status: "ok", detail: `${def.name} (${def.remote.host}) reachable, daemon running` };
}

// --- Runner ---

async function runChecks(opts: { includeRemote: boolean }): Promise<DoctorCheck[]> {
  const config = loadConfig();
  const checks: DoctorCheck[] = [];

  const auth = guard("auth", checkAuth);
  checks.push(auth);
  const authenticated = auth.status === "ok";

  const { locked, pid } = isLocked();
  checks.push(guard("daemon", () => checkDaemon(authenticated, locked, pid)));

  const daemonState = locked ? readDaemonState() : null;
  const staleSeconds = config.whatsapp.watchdog_stale_seconds;
  checks.push(guard("stream", () => checkStream(locked, daemonState, staleSeconds)));
  checks.push(guard("store_write", () => checkStoreWrite(daemonState)));
  checks.push(guard("fts_integrity", () => checkFtsIntegrity(config)));

  try {
    checks.push(...checkEnrich(config));
  } catch (err) {
    checks.push({ name: "enrich", status: "fail", detail: `check crashed: ${(err as Error).message}` });
  }

  checks.push(await guardAsync("remote", () => checkRemote(config, opts.includeRemote)));

  return checks;
}

const STATUS_MARK: Record<CheckStatus, string> = {
  ok: "✓",
  warn: "⚠",
  fail: "✗",
  skip: "·",
};

function printReport(checks: DoctorCheck[], overall: DoctorSummary["overall"]): void {
  const nameWidth = Math.max(...checks.map((c) => c.name.length), 4);
  for (const c of checks) {
    console.log(`${STATUS_MARK[c.status]} ${c.name.padEnd(nameWidth)}  ${c.detail}`);
    if (c.fix) {
      console.log(`${" ".repeat(nameWidth + 3)}fix: ${c.fix}`);
    }
  }
  console.log("");
  console.log(`Overall: ${overall}`);
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Diagnose wu health - daemon, stream, storage, and enrichment (read-only)")
    .option("--json", "Output as JSON")
    .option("--remote", "Also probe the default remote over SSH (adds latency)")
    .action(async (opts: { json?: boolean; remote?: boolean }) => {
      const checks = await runChecks({ includeRemote: !!opts.remote });
      const { overall, exitCode } = summarize(checks);

      if (opts.json) {
        console.log(JSON.stringify({ checks, overall }, null, 2));
      } else {
        printReport(checks, overall);
      }

      process.exit(exitCode);
    });
}
