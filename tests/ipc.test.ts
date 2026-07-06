import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "net";
import { existsSync, unlinkSync, mkdtempSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { EventEmitter } from "node:events";
import type { WASocket } from "@whiskeysockets/baileys";
import type { WuConfig } from "../src/config/schema.js";

// Redirect WU_HOME to a throwaway dir before importing anything that reads it -
// src/config/paths.ts freezes DB_PATH from WU_HOME at module load, so a later
// assignment would leak the backfill test's writes into the real ~/.wu DB.
const home = mkdtempSync(join(tmpdir(), "wu-ipc-"));
process.env.WU_HOME = home;
mkdirSync(join(home, "auth"), { recursive: true });

let ipc: typeof import("../src/core/ipc.js");
let store: typeof import("../src/core/store.js");
let database: typeof import("../src/db/database.js");

before(async () => {
  ipc = await import("../src/core/ipc.js");
  store = await import("../src/core/store.js");
  database = await import("../src/db/database.js");
});

after(() => {
  rmSync(home, { recursive: true, force: true });
});

// Short unique path — unix sockets have a ~104 char limit on macOS.
const SOCK = join(tmpdir(), `wu-ipc-${process.pid}.sock`);

describe("daemon IPC transport", () => {
  let stop: () => void;

  before(() => {
    // No live socket — exercises the request/response framing and the
    // "not connected" path without needing WhatsApp.
    stop = ipc.startDaemonIpc(() => undefined as unknown as WASocket, {} as WuConfig, SOCK);
  });

  after(() => stop());

  it("reports availability when listening", async () => {
    assert.equal(await ipc.daemonIpcAvailable(1000, SOCK), true);
  });

  it("answers ping without a socket", async () => {
    const res = await ipc.daemonRequest<{ pong: boolean }>("ping", {}, 5000, SOCK);
    assert.deepEqual(res, { pong: true });
  });

  it("rejects media calls when the daemon has no socket", async () => {
    await assert.rejects(
      () => ipc.daemonRequest("media.download", { msgId: "abc" }, 5000, SOCK),
      /not connected/i
    );
  });

  it("rejects unknown methods", async () => {
    await assert.rejects(
      () => ipc.daemonRequest("does.not.exist", {}, 5000, SOCK),
      /Unknown IPC method/
    );
  });

  it("rejects history.backfill when the daemon has no socket", async () => {
    await assert.rejects(
      () => ipc.daemonRequest("history.backfill", { jid: "team@g.us" }, 5000, SOCK),
      /not connected/i
    );
  });
});

// End-to-end proof that a backfill request routes through the daemon's live
// socket (over IPC) and returns the new-message tally - the whole point of
// backfilling while the daemon holds the only WhatsApp session.
describe("daemon IPC history.backfill routing", () => {
  const BF_SOCK = join(tmpdir(), `wu-ipc-bf-${process.pid}.sock`);
  let stopBf: () => void;

  before(() => {
    database.getDb();
    // Anchor message: backfill walks backward from the oldest known message.
    store.upsertMessage({
      id: "anchor-1",
      chat_jid: "backfill-test@g.us",
      sender_jid: "111@s.whatsapp.net",
      sender_name: "Alice",
      body: "newest before backfill",
      type: "text",
      media_mime: null, media_path: null, media_size: null,
      media_direct_path: null, media_key: null, media_file_sha256: null,
      media_file_enc_sha256: null, media_file_length: null,
      quoted_id: null, location_lat: null, location_lon: null, location_name: null,
      is_from_me: 0, timestamp: 1700001000, raw: "{}",
    });
  });

  after(() => {
    if (stopBf) stopBf();
    try { if (existsSync(BF_SOCK)) unlinkSync(BF_SOCK); } catch { /* best effort */ }
  });

  it("fetches on the daemon's socket and reports the new messages", async () => {
    const ev = new EventEmitter();
    let fetchArgs: unknown[] | undefined;
    // Stub the history fetch: persist two older messages and emit the event
    // backfillHistory waits on, mimicking Baileys delivering a history chunk.
    const older = [
      { id: "old-1", timestamp: 1700000100 },
      { id: "old-2", timestamp: 1700000200 },
    ];
    const sock = {
      ev,
      fetchMessageHistory: (...args: unknown[]) => {
        fetchArgs = args;
        setImmediate(() => {
          for (const m of older) {
            store.upsertMessage({
              id: m.id, chat_jid: "backfill-test@g.us",
              sender_jid: "111@s.whatsapp.net", sender_name: "Alice",
              body: "older", type: "text",
              media_mime: null, media_path: null, media_size: null,
              media_direct_path: null, media_key: null, media_file_sha256: null,
              media_file_enc_sha256: null, media_file_length: null,
              quoted_id: null, location_lat: null, location_lon: null, location_name: null,
              is_from_me: 0, timestamp: m.timestamp, raw: "{}",
            });
          }
          ev.emit("messaging-history.set", {
            messages: older.map((m) => ({ key: { remoteJid: "backfill-test@g.us", id: m.id } })),
          });
        });
        return "session-abc";
      },
    };

    stopBf = ipc.startDaemonIpc(
      () => sock as unknown as WASocket,
      { constraints: { default: "full", chats: {} } } as unknown as WuConfig,
      BF_SOCK
    );

    const result = await ipc.daemonRequest<{ requested: number; newMessages: number; oldestTimestamp: number | null }>(
      "history.backfill",
      { jid: "backfill-test@g.us", count: 2, timeoutMs: 5000 },
      20_000,
      BF_SOCK
    );

    assert.equal(result.requested, 2);
    assert.equal(result.newMessages, 2);
    assert.equal(result.oldestTimestamp, 1700000100);
    // The fetch ran against the daemon's socket anchored on the oldest known
    // message, not a competing login.
    assert.ok(fetchArgs, "fetchMessageHistory was invoked on the daemon socket");
    const key = fetchArgs![1] as { id: string; remoteJid: string };
    assert.equal(key.id, "anchor-1");
  });
});

describe("daemon IPC availability", () => {
  it("is false when nothing is listening", async () => {
    const missing = join(tmpdir(), `wu-ipc-missing-${process.pid}.sock`);
    assert.equal(await ipc.daemonIpcAvailable(500, missing), false);
  });
});

describe("daemon IPC client close handling", () => {
  const DEAD_SOCK = join(tmpdir(), `wu-ipc-dead-${process.pid}.sock`);
  let deadServer: Server;

  before(async () => {
    if (existsSync(DEAD_SOCK)) {
      try { unlinkSync(DEAD_SOCK); } catch { /* best effort */ }
    }
    deadServer = createServer((conn) => {
      // Accept the connection, let the client's request land, then hang up
      // without ever writing a response - simulates a daemon that dies
      // mid-request. Destroying only after "data" avoids a write-side EPIPE
      // race that would mask the close path this test targets.
      conn.once("data", () => conn.destroy());
    });
    await new Promise<void>((resolve) => deadServer.listen(DEAD_SOCK, resolve));
  });

  after(async () => {
    await new Promise<void>((resolve) => deadServer.close(() => resolve()));
    try { if (existsSync(DEAD_SOCK)) unlinkSync(DEAD_SOCK); } catch { /* best effort */ }
  });

  it("rejects quickly when the daemon closes without responding", async () => {
    const start = Date.now();
    await assert.rejects(
      () => ipc.daemonRequest("ping", {}, 300_000, DEAD_SOCK),
      /closed the connection/
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 5000, `expected fast rejection, took ${elapsed}ms`);
  });
});
