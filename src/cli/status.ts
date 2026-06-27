import { Command } from "commander";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { AUTH_DIR } from "../config/paths.js";
import { isLocked } from "../core/lock.js";
import { readDaemonState, type DaemonStateData } from "../core/daemon-state.js";
import { loadConfig } from "../config/schema.js";
import { EXIT_NOT_AUTHENTICATED } from "./exit-codes.js";

interface StreamInfo {
  connection: DaemonStateData["connection"];
  connected_since: number | null;
  last_event_at: number | null;
  last_message_at: number | null;
  stream_age_seconds: number | null;
  state_age_seconds: number;
  stale: boolean;
  reconnect_count: number;
  watchdog_restarts: number;
  last_disconnect_reason: number | null;
  fts_rebuilds: number;
  last_store_error: string | null;
  last_store_error_at: number | null;
  store_healthy: boolean;
}

// A write failure within this window means ingestion is currently degraded:
// the socket can read healthy while the DB write path is throwing.
const STORE_ERROR_FRESH_SECONDS = 600;

// Derive a live stream summary from the daemon heartbeat. Returns null when no
// heartbeat exists (older daemon, or never started). `stale` flips when the
// socket is believed open but has gone silent past the watchdog window, the
// signal that "connected/authenticated" is lying about ingestion.
function buildStreamInfo(staleSeconds: number): StreamInfo | null {
  const data = readDaemonState();
  if (!data) return null;
  const now = Math.floor(Date.now() / 1000);
  const streamAge = data.last_event_at == null ? null : now - data.last_event_at;
  const stale =
    data.connection === "open" &&
    staleSeconds > 0 &&
    streamAge != null &&
    streamAge >= staleSeconds;
  const storeHealthy =
    data.last_store_error_at == null ||
    now - data.last_store_error_at >= STORE_ERROR_FRESH_SECONDS;
  return {
    connection: data.connection,
    connected_since: data.connected_since,
    last_event_at: data.last_event_at,
    last_message_at: data.last_message_at,
    stream_age_seconds: streamAge,
    state_age_seconds: now - data.updated_at,
    stale,
    reconnect_count: data.reconnect_count,
    watchdog_restarts: data.watchdog_restarts,
    last_disconnect_reason: data.last_disconnect_reason,
    fts_rebuilds: data.fts_rebuilds,
    last_store_error: data.last_store_error,
    last_store_error_at: data.last_store_error_at,
    store_healthy: storeHealthy,
  };
}

function fmtAge(seconds: number | null): string {
  if (seconds == null) return "never";
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  return `${(seconds / 3600).toFixed(1)}h ago`;
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show connection status and account info")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => {
      const credsPath = join(AUTH_DIR, "creds.json");
      if (!existsSync(credsPath)) {
        if (opts.json) {
          console.log(JSON.stringify({ authenticated: false }));
        } else {
          console.log("Not authenticated. Run `wu login` to connect.");
        }
        process.exit(EXIT_NOT_AUTHENTICATED);
      }

      try {
        const creds = JSON.parse(readFileSync(credsPath, "utf-8"));
        const { locked } = isLocked();
        const staleSeconds = loadConfig().whatsapp.watchdog_stale_seconds;
        // Only trust the heartbeat while the daemon process is actually up; a
        // leftover file from a dead daemon would otherwise read as live.
        const stream = locked ? buildStreamInfo(staleSeconds) : null;
        const info = {
          authenticated: true,
          daemon_running: locked,
          phone: creds.me?.id?.split(":")[0] || creds.me?.id || "unknown",
          name: creds.me?.name || "unknown",
          platform: creds.platform || "unknown",
          registered: creds.registered ?? false,
          stream,
        };

        if (opts.json) {
          console.log(JSON.stringify(info, null, 2));
        } else {
          console.log(`Authenticated: yes`);
          console.log(`Phone: ${info.phone}`);
          console.log(`Name: ${info.name}`);
          console.log(`Platform: ${info.platform}`);
          console.log(`Daemon running: ${locked ? "yes" : "no"}`);
          if (stream) {
            const flag = stream.stale ? "  ⚠ STALE" : "";
            console.log(`Stream: ${stream.connection}${flag}`);
            console.log(`Last event: ${fmtAge(stream.stream_age_seconds)}`);
            console.log(`Last message: ${fmtAge(stream.last_message_at == null ? null : Math.floor(Date.now() / 1000) - stream.last_message_at)}`);
            if (!stream.store_healthy) {
              console.log(`Ingestion: ⚠ DEGRADED. Last write error ${fmtAge(stream.last_store_error_at == null ? null : Math.floor(Date.now() / 1000) - stream.last_store_error_at)}: ${stream.last_store_error}`);
            }
            if (stream.fts_rebuilds > 0) {
              console.log(`FTS auto-rebuilds: ${stream.fts_rebuilds}`);
            }
            if (stream.watchdog_restarts > 0) {
              console.log(`Watchdog restarts: ${stream.watchdog_restarts}`);
            }
          } else if (locked) {
            console.log(`Stream: unknown (daemon predates heartbeat, restart it)`);
          }
        }
      } catch {
        console.log("Session exists but credentials may be corrupted.");
        console.log("Try `wu logout` and `wu login` to re-authenticate.");
      }
    });
}
