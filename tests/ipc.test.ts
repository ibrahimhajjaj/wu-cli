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
    stop = ipc.startDaemonIpc(() => undefined as unknown as WASocket, () => ({}) as WuConfig, SOCK);
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
      /predates `does.not.exist`/
    );
  });

  it("rejects history.backfill when the daemon has no socket", async () => {
    await assert.rejects(
      () => ipc.daemonRequest("history.backfill", { jid: "team@g.us" }, 5000, SOCK),
      /not connected/i
    );
  });

  it("exposes the group-metadata methods and gates them on a live socket", async () => {
    await assert.rejects(
      () => ipc.daemonRequest("groups.refresh", {}, 5000, SOCK),
      /not connected/i
    );
    await assert.rejects(
      () => ipc.daemonRequest("groups.metadata", { jid: "team@g.us" }, 5000, SOCK),
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
      () => ({ constraints: { default: "full", chats: {} } }) as unknown as WuConfig,
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

// Sends, reactions, deletes and group changes ride the daemon's socket. A
// one-shot login for them replaces the daemon's session (440), and the daemon's
// reconnect then knocks the one-shot off mid-send, so the message goes out and
// the caller still sees "connection closed".
describe("daemon IPC socket actions", () => {
  const ACT_SOCK = join(tmpdir(), `wu-ipc-act-${process.pid}.sock`);
  let stopAct: () => void;
  let fake: import("./helpers/fake-socket.js").FakeSocket;
  let schema: typeof import("../src/config/schema.js");

  before(async () => {
    const { makeFakeSocket } = await import("./helpers/fake-socket.js");
    schema = await import("../src/config/schema.js");
    database.getDb();
    fake = makeFakeSocket();
    const config = schema.WuConfigSchema.parse({
      constraints: { default: "full" },
      whatsapp: { send_delay_ms: 0 },
    });
    stopAct = ipc.startDaemonIpc(() => fake.sock, () => config, ACT_SOCK);
  });

  after(() => {
    if (stopAct) stopAct();
    try { if (existsSync(ACT_SOCK)) unlinkSync(ACT_SOCK); } catch { /* best effort */ }
  });

  it("sends on the daemon's socket and returns a plain id and timestamp", async () => {
    fake.calls.length = 0;
    const res = await ipc.runAction<{ id: string; timestamp: number }>(
      "messages.send",
      { to: "team@g.us", text: "hello" },
      {} as WuConfig,
      { sockPath: ACT_SOCK }
    );
    assert.deepEqual(res, { id: "fake-msg-id", timestamp: 1700000000 });
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(fake.calls[0]!.args.slice(0, 2), ["team@g.us", { text: "hello" }]);
  });

  it("revokes on the daemon's socket", async () => {
    fake.calls.length = 0;
    const res = await ipc.runAction<{ id: string }>(
      "messages.delete",
      { jid: "team@g.us", msgId: "m-1" },
      {} as WuConfig,
      { sockPath: ACT_SOCK }
    );
    assert.equal(res.id, "m-1");
    assert.deepEqual(fake.calls[0]!.args[1], {
      delete: { remoteJid: "team@g.us", id: "m-1", fromMe: false },
    });
  });

  it("keeps the send validation on the daemon side", async () => {
    await assert.rejects(
      () => ipc.runAction("messages.send", { to: "team@g.us" }, {} as WuConfig, { sockPath: ACT_SOCK }),
      /Provide text, media, or a poll/
    );
    await assert.rejects(
      () => ipc.runAction(
        "messages.send",
        { to: "team@g.us", poll: "Q?", options: ["only one"] },
        {} as WuConfig,
        { sockPath: ACT_SOCK }
      ),
      /at least 2 options/
    );
  });

  it("keeps the constraint exit code when the daemon refuses", async () => {
    const schema = await import("../src/config/schema.js");
    const BLOCK_SOCK = join(tmpdir(), `wu-ipc-blk-${process.pid}.sock`);
    const blocked = schema.WuConfigSchema.parse({ constraints: { default: "none" } });
    const stopBlk = ipc.startDaemonIpc(() => fake.sock, () => blocked, BLOCK_SOCK);
    try {
      await assert.rejects(
        () => ipc.runAction("messages.send", { to: "team@g.us", text: "x" }, {} as WuConfig, { sockPath: BLOCK_SOCK }),
        (err: Error & { exitCode?: number }) => err.exitCode === 2
      );
    } finally {
      stopBlk();
    }
  });

  it("tells the caller to restart a daemon that predates the method", async () => {
    // An old daemon still listening: it answers, but not this method.
    const OLD_SOCK = join(tmpdir(), `wu-ipc-old-${process.pid}.sock`);
    const old: Server = createServer((conn) => {
      conn.on("data", (chunk) => {
        const req = JSON.parse(chunk.toString().trim());
        conn.write(JSON.stringify({ id: req.id, ok: false, error: `Unknown IPC method: ${req.method}` }) + "\n");
      });
    });
    await new Promise<void>((r) => old.listen(OLD_SOCK, r));
    try {
      await assert.rejects(
        () => ipc.runAction("messages.send", { to: "team@g.us", text: "x" }, {} as WuConfig, { sockPath: OLD_SOCK }),
        /predates `messages.send`.*Restart it/
      );
    } finally {
      old.close();
      try { if (existsSync(OLD_SOCK)) unlinkSync(OLD_SOCK); } catch { /* best effort */ }
    }
  });
});

describe("daemon IPC delete of a message missing from the store", () => {
  const DEL_SOCK = join(tmpdir(), `wu-ipc-del-${process.pid}.sock`);
  let stopDel: () => void;
  let fake: import("./helpers/fake-socket.js").FakeSocket;

  before(async () => {
    const { makeFakeSocket } = await import("./helpers/fake-socket.js");
    const schema = await import("../src/config/schema.js");
    database.getDb();
    fake = makeFakeSocket();
    const config = schema.WuConfigSchema.parse({
      constraints: { default: "full" },
      whatsapp: { send_delay_ms: 0 },
    });
    stopDel = ipc.startDaemonIpc(() => fake.sock, () => config, DEL_SOCK);
  });

  after(() => {
    if (stopDel) stopDel();
    try { if (existsSync(DEL_SOCK)) unlinkSync(DEL_SOCK); } catch { /* best effort */ }
  });

  it("revokes as our own message when the caller says so", async () => {
    await ipc.runAction(
      "messages.delete",
      { jid: "team@g.us", msgId: "never-stored", fromMe: true },
      {} as WuConfig,
      { sockPath: DEL_SOCK }
    );
    assert.deepEqual(fake.calls[0]!.args[1], {
      delete: { remoteJid: "team@g.us", id: "never-stored", fromMe: true },
    });
  });
});
