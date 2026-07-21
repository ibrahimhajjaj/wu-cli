import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { WAMessage } from "@whiskeysockets/baileys";
import { makeFakeSocket } from "./helpers/fake-socket.js";

// Point the singleton DB at a throwaway home before importing the store, so
// startListener writes through the real schema (same pattern as
// tests/fts-recovery.test.ts and tests/ipc.test.ts).
const home = mkdtempSync(join(tmpdir(), "wu-listener-"));
process.env.WU_HOME = home;
mkdirSync(join(home, "auth"), { recursive: true });

let store: typeof import("../src/core/store.js");
let database: typeof import("../src/db/database.js");
let listener: typeof import("../src/core/listener.js");
let schema: typeof import("../src/config/schema.js");

before(async () => {
  database = await import("../src/db/database.js");
  store = await import("../src/core/store.js");
  listener = await import("../src/core/listener.js");
  schema = await import("../src/config/schema.js");
  database.getDb();
});

after(() => {
  database.closeDb();
  rmSync(home, { recursive: true, force: true });
});

// Minimal valid WAMessage literal matching what listener.ts's parseMessage
// reads: key.{remoteJid,id,participant,fromMe}, message, messageTimestamp,
// pushName.
function textMessage(opts: {
  chatJid: string;
  id: string;
  body: string;
  participant?: string;
  pushName?: string;
  timestamp?: number;
}): WAMessage {
  return {
    key: {
      remoteJid: opts.chatJid,
      id: opts.id,
      participant: opts.participant,
      fromMe: false,
    },
    message: { conversation: opts.body },
    messageTimestamp: opts.timestamp ?? 1700000000,
    pushName: opts.pushName,
  } as unknown as WAMessage;
}

describe("startListener - messages.upsert", () => {
  it("persists a normal text message with the right fields", () => {
    const { sock, emitUpsert } = makeFakeSocket();
    const config = schema.WuConfigSchema.parse({
      constraints: { default: "read" },
    });
    listener.startListener(sock, { config, quiet: true });

    emitUpsert([
      textMessage({
        chatJid: "allowed@g.us",
        id: "persist-1",
        body: "hello world",
        participant: "111@s.whatsapp.net",
        pushName: "Alice",
      }),
    ]);

    const row = store.getMessage("persist-1");
    assert.ok(row, "message should be persisted");
    assert.equal(row!.chat_jid, "allowed@g.us");
    assert.equal(row!.body, "hello world");
    assert.equal(row!.type, "text");
    assert.equal(row!.sender_jid, "111@s.whatsapp.net");
    assert.equal(row!.sender_name, "Alice");
    assert.equal(row!.is_from_me, 0);

    // Chat and contact side effects also fire off the same event.
    const chat = store.listChats({ limit: 10 }).find((c) => c.jid === "allowed@g.us");
    assert.ok(chat, "chat should be upserted");
    assert.equal(chat!.type, "group");
    const contact = store
      .listContacts({ limit: 10 })
      .find((c) => c.jid === "111@s.whatsapp.net");
    assert.ok(contact, "contact should be upserted");
    assert.equal(contact!.push_name, "Alice");
  });

  it("does not persist a message from a chat the constraint gate blocks", () => {
    const { sock, emitUpsert } = makeFakeSocket();
    const config = schema.WuConfigSchema.parse({
      constraints: { default: "none", chats: { "allowed2@g.us": { mode: "read" } } },
    });
    listener.startListener(sock, { config, quiet: true });

    emitUpsert([
      textMessage({ chatJid: "blocked@g.us", id: "gate-1", body: "nope" }),
    ]);

    assert.equal(store.getMessage("gate-1"), undefined);
  });

  it("dedupes a repeated jid:id pair within the same listener instance", () => {
    const { sock, emitUpsert } = makeFakeSocket();
    const config = schema.WuConfigSchema.parse({
      constraints: { default: "read" },
    });
    listener.startListener(sock, { config, quiet: true });

    emitUpsert([
      textMessage({ chatJid: "dedup@g.us", id: "dedup-1", body: "first" }),
    ]);
    // Second emit with the same key but a different body - if the FIFO dedup
    // gate (keyed on `${jid}:${id}`) works, this never reaches upsertMessage
    // and the stored body stays "first". If dedup were broken, the ON
    // CONFLICT COALESCE in upsertMessage would overwrite it to "second".
    emitUpsert([
      textMessage({ chatJid: "dedup@g.us", id: "dedup-1", body: "second" }),
    ]);

    const row = store.getMessage("dedup-1");
    assert.ok(row);
    assert.equal(row!.body, "first", "duplicate emit should be dropped, not re-applied");
  });

  it("skips a message with no key.id (no row, no throw)", () => {
    const { sock, emitUpsert } = makeFakeSocket();
    const config = schema.WuConfigSchema.parse({
      constraints: { default: "full" },
    });
    listener.startListener(sock, { config, quiet: true });

    assert.doesNotThrow(() => {
      emitUpsert([
        {
          key: { remoteJid: "1234567890@s.whatsapp.net", fromMe: false },
          message: { conversation: "hello, no id" },
          messageTimestamp: 1700000000,
        },
      ]);
    });

    // Scoped to this test's own chat_jid, not a whole-table count: earlier
    // tests in this describe already persist rows into the shared singleton.
    const rows = database
      .getDb()
      .prepare("SELECT * FROM messages WHERE chat_jid = ?")
      .all("1234567890@s.whatsapp.net");
    assert.equal(rows.length, 0, "message with no key.id should not be persisted");
  });
});

describe("startListener - messages.update", () => {
  it("marks a message deleted on a revoke update", () => {
    const { sock, emitUpsert, emitUpdate } = makeFakeSocket();
    const config = schema.WuConfigSchema.parse({
      constraints: { default: "read" },
    });
    listener.startListener(sock, { config, quiet: true });

    emitUpsert([
      textMessage({ chatJid: "revoke@g.us", id: "revoke-1", body: "will be revoked" }),
    ]);
    assert.equal(store.getMessage("revoke-1")!.body, "will be revoked");

    emitUpdate([
      { key: { remoteJid: "revoke@g.us", id: "revoke-1" }, update: { message: null } },
    ]);

    const row = store.getMessage("revoke-1");
    assert.ok(row);
    assert.equal(row!.type, "deleted");
    assert.equal(row!.body, null);
    assert.equal(row!.raw, null);
  });

  it("ignores updates for chats the constraint gate blocks", () => {
    const { sock, emitUpsert, emitUpdate } = makeFakeSocket();
    const config = schema.WuConfigSchema.parse({
      constraints: { default: "none", chats: { "allowed3@g.us": { mode: "read" } } },
    });
    listener.startListener(sock, { config, quiet: true });

    emitUpsert([
      textMessage({ chatJid: "allowed3@g.us", id: "gate-update-1", body: "kept" }),
    ]);

    emitUpdate([
      { key: { remoteJid: "blocked3@g.us", id: "gate-update-1" }, update: { message: null } },
    ]);

    // The update targeted a different (blocked) chat_jid than the stored
    // message's, so markMessageDeleted must not have fired via that path.
    const row = store.getMessage("gate-update-1");
    assert.ok(row);
    assert.equal(row!.type, "text", "update on a blocked chat must not mutate the message");
  });
});

describe("startListener - live config (setConfig)", () => {
  it("starts collecting a group allowed after the listener is running, no restart", () => {
    const { sock, emitUpsert } = makeFakeSocket();
    const blocking = schema.WuConfigSchema.parse({
      constraints: { default: "none" },
    });
    const handle = listener.startListener(sock, { config: blocking, quiet: true });

    // Before: the group is not allowlisted, so its message is dropped.
    emitUpsert([
      textMessage({ chatJid: "late-allow@g.us", id: "live-1", body: "missed" }),
    ]);
    assert.equal(store.getMessage("live-1"), undefined, "blocked before allow");

    // Swap in a config that allows the group - mimics `wu config allow`
    // reaching the running daemon via the file watcher.
    handle.setConfig(
      schema.WuConfigSchema.parse({
        constraints: { default: "none", chats: { "late-allow@g.us": { mode: "read" } } },
      })
    );

    emitUpsert([
      textMessage({ chatJid: "late-allow@g.us", id: "live-2", body: "captured" }),
    ]);
    const row = store.getMessage("live-2");
    assert.ok(row, "message collected after the live allow");
    assert.equal(row!.body, "captured");
  });
});

describe("startListener - prime on first message", () => {
  it("primes a pending group on its first stored message, once, and clears it", () => {
    const { sock, emitUpsert } = makeFakeSocket();
    const config = schema.WuConfigSchema.parse({ constraints: { default: "read" } });
    const primePending = new Map<string, number>([["prime-me@g.us", 0]]);
    const primed: string[] = [];
    listener.startListener(sock, {
      config,
      quiet: true,
      primePending,
      onPrime: (_s, jid) => primed.push(jid),
    });

    // Two messages for the pending group in one batch: prime fires once.
    emitUpsert([
      textMessage({ chatJid: "prime-me@g.us", id: "pm-1", body: "first" }),
      textMessage({ chatJid: "prime-me@g.us", id: "pm-2", body: "second" }),
    ]);

    assert.deepEqual(primed, ["prime-me@g.us"], "primed exactly once");
    assert.ok(!primePending.has("prime-me@g.us"), "cleared from the pending set");

    // A group that was never pending does not prime.
    emitUpsert([textMessage({ chatJid: "other@g.us", id: "o-1", body: "x" })]);
    assert.deepEqual(primed, ["prime-me@g.us"], "no prime for a non-pending group");
  });
});
