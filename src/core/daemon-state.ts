import { writeFileSync, renameSync, readFileSync, existsSync } from "fs";
import type { WASocket } from "@whiskeysockets/baileys";
import { DAEMON_STATE_PATH } from "../config/paths.js";

// The lockfile only proves the process is alive and creds.json only proves it
// once authenticated. Neither says whether the WhatsApp event stream is still
// delivering. When the socket half-dies without firing a connection.update
// close, the daemon keeps serving an authenticated session while ingesting
// nothing.
// This module records a heartbeat so `wu status` (a separate process, possibly
// over SSH) can tell a live stream from a stale one.

export type ConnectionPhase = "connecting" | "open" | "close";

export interface DaemonStateData {
  pid: number;
  // unix seconds throughout
  started_at: number;
  connection: ConnectionPhase;
  connected_since: number | null;
  // wall-clock receipt time of the last socket event of any kind, the stream
  // liveness signal. Fed by all account traffic (receipts, presence, ...),
  // not just collected chats, so a quiet allowlist doesn't read as a dead link.
  last_event_at: number | null;
  // wall-clock receipt time of the last live collected message.
  last_message_at: number | null;
  last_disconnect_at: number | null;
  last_disconnect_reason: number | null;
  reconnect_count: number;
  watchdog_restarts: number;
  // Ingestion health. A live socket can still fail to persist if the DB write
  // path throws (e.g. a corrupt FTS index): fts_rebuilds counts in-place
  // recoveries, last_store_error records a write that failed even after that.
  fts_rebuilds: number;
  last_store_error_at: number | null;
  last_store_error: string | null;
  // refreshed by the watchdog tick even during silence, so a fresh updated_at
  // with a stale last_event_at is the exact "stream died, process alive" case.
  updated_at: number;
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

// Socket events that prove the stream is alive. Receipts and presence flow from
// the whole account regardless of constraints, so they keep the heartbeat warm
// even when every collected chat is quiet.
const LIVENESS_EVENTS = [
  "messages.upsert",
  "messages.update",
  "messages.reaction",
  "message-receipt.update",
  "presence.update",
  "chats.upsert",
  "chats.update",
  "contacts.upsert",
  "contacts.update",
  "groups.update",
  "messaging-history.set",
];

export class DaemonState {
  private data: DaemonStateData;
  private dirty = false;
  private writeTimer: ReturnType<typeof setTimeout> | undefined;
  private path: string;

  constructor(path: string = DAEMON_STATE_PATH) {
    this.path = path;
    const t = now();
    this.data = {
      pid: process.pid,
      started_at: t,
      connection: "connecting",
      connected_since: null,
      last_event_at: null,
      last_message_at: null,
      last_disconnect_at: null,
      last_disconnect_reason: null,
      reconnect_count: 0,
      watchdog_restarts: 0,
      fts_rebuilds: 0,
      last_store_error_at: null,
      last_store_error: null,
      updated_at: t,
    };
    this.flush();
  }

  // Fold in the store layer's self-reported health so a stalled write path is
  // visible in status even while the socket reads healthy.
  recordStoreHealth(health: {
    fts_rebuilds: number;
    last_store_error_at: number | null;
    last_store_error: string | null;
  }): void {
    this.data.fts_rebuilds = health.fts_rebuilds;
    this.data.last_store_error_at = health.last_store_error_at;
    this.data.last_store_error = health.last_store_error;
  }

  markEvent(): void {
    this.data.last_event_at = now();
    this.scheduleWrite();
  }

  markMessage(): void {
    const t = now();
    this.data.last_message_at = t;
    this.data.last_event_at = t;
    this.scheduleWrite();
  }

  setOpen(): void {
    const t = now();
    this.data.connection = "open";
    this.data.connected_since = t;
    this.data.last_event_at = t;
    this.flush();
  }

  setConnecting(reason?: number): void {
    this.data.connection = "connecting";
    if (reason !== undefined) this.data.last_disconnect_reason = reason;
    this.data.reconnect_count++;
    this.flush();
  }

  setClosed(reason?: number): void {
    this.data.connection = "close";
    this.data.connected_since = null;
    this.data.last_disconnect_at = now();
    if (reason !== undefined) this.data.last_disconnect_reason = reason;
    this.flush();
  }

  markWatchdogRestart(): void {
    this.data.watchdog_restarts++;
    this.flush();
  }

  /** Seconds since the last socket event, or null if none seen yet. */
  streamAge(): number | null {
    if (this.data.last_event_at == null) return null;
    return now() - this.data.last_event_at;
  }

  isOpen(): boolean {
    return this.data.connection === "open";
  }

  // Bind heartbeat tracking to a live socket. The listeners live for the
  // socket's lifetime, which ends when it is replaced on reconnect.
  attach(sock: WASocket): void {
    for (const ev of LIVENESS_EVENTS) {
      sock.ev.on(ev as any, () => this.markEvent());
    }
  }

  private scheduleWrite(): void {
    this.dirty = true;
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      if (this.dirty) this.flush();
    }, 3000);
    this.writeTimer.unref?.();
  }

  flush(): void {
    this.dirty = false;
    this.data.updated_at = now();
    try {
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data), "utf-8");
      renameSync(tmp, this.path);
    } catch {
      // best effort: a missing heartbeat just degrades status, never the daemon
    }
  }

  stop(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
  }
}

export function readDaemonState(
  path: string = DAEMON_STATE_PATH
): DaemonStateData | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as DaemonStateData;
  } catch {
    return null;
  }
}
