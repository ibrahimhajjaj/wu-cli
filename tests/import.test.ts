import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Point the singleton DB at a throwaway home before importing the store, so
// the real schema (messages/chats + FTS triggers) backs every assertion.
// Mirrors tests/fts-recovery.test.ts.
const home = mkdtempSync(join(tmpdir(), "wu-import-"));
process.env.WU_HOME = home;
mkdirSync(join(home, "auth"), { recursive: true });

let store: typeof import("../src/core/store.js");
let database: typeof import("../src/db/database.js");
let exportMod: typeof import("../src/core/export.js");
let importMod: typeof import("../src/core/import.js");

before(async () => {
  database = await import("../src/db/database.js");
  store = await import("../src/core/store.js");
  exportMod = await import("../src/core/export.js");
  importMod = await import("../src/core/import.js");
  database.getDb();
});

after(() => {
  database.closeDb();
  rmSync(home, { recursive: true, force: true });
});

const outDir = join(home, "export-out");
mkdirSync(outDir, { recursive: true });
let fileCounter = 0;
function tmpJsonlPath(): string {
  fileCounter++;
  return join(outDir, `export-${fileCounter}.jsonl`);
}

function seedMessage(row: Partial<Parameters<typeof store.upsertMessage>[0]> & { id: string; chat_jid: string; timestamp: number }) {
  store.upsertMessage({
    sender_jid: null,
    sender_name: null,
    body: null,
    type: "text",
    media_mime: null,
    media_path: null,
    media_size: null,
    media_direct_path: null,
    media_key: null,
    media_file_sha256: null,
    media_file_enc_sha256: null,
    media_file_length: null,
    quoted_id: null,
    location_lat: null,
    location_lon: null,
    location_name: null,
    is_from_me: 0,
    raw: null,
    ...row,
  });
}

function wipeMessages() {
  database.getDb().exec("DELETE FROM messages");
  database.getDb().exec("DELETE FROM chats");
}

describe("importMessagesJsonl - round trip", () => {
  beforeEach(() => {
    wipeMessages();
  });

  it("exports a seeded chat to jsonl and imports it back searchable", () => {
    const chatJid = "120363111@g.us";
    seedMessage({ id: "rt1", chat_jid: chatJid, timestamp: 1700000001, body: "budget review tomorrow", sender_name: "Ali" });
    seedMessage({ id: "rt2", chat_jid: chatJid, timestamp: 1700000002, body: "sounds good", sender_name: "Dona" });

    const file = tmpJsonlPath();
    const exportResult = exportMod.exportMessages({ chatJid, format: "jsonl", output: file });
    assert.equal(exportResult.messages_exported, 2);

    wipeMessages();
    assert.equal(store.getMessageCount(), 0);

    const result = importMod.importMessagesJsonl(file);
    assert.equal(result.imported, 2);
    assert.equal(result.skipped, 0);
    assert.equal(result.invalid, 0);

    const hit = store.searchMessages("budget");
    assert.ok(hit.some((m) => m.id === "rt1"), "imported row is searchable via FTS");

    const restored = store.getMessage("rt2");
    assert.ok(restored);
    assert.equal(restored?.body, "sounds good");
    assert.equal(restored?.chat_jid, chatJid);

    // Chat row synthesized so the imported messages surface in chats list.
    const chats = store.listChats();
    const chat = chats.find((c) => c.jid === chatJid);
    assert.ok(chat, "a minimal chat row was synthesized");
    assert.equal(chat?.type, "group");
    assert.equal(chat?.last_message_at, 1700000002);
  });

  it("merge mode does not clobber an existing fuller row with an imported partial", () => {
    const chatJid = "1@s.whatsapp.net";
    seedMessage({
      id: "m1",
      chat_jid: chatJid,
      timestamp: 1700000010,
      body: "hello",
      raw: '{"key":{"id":"m1"}}',
      media_file_sha256: "abc123",
    });

    // Simulate a lossy jsonl row for the same id: no raw, no media crypto.
    const file = tmpJsonlPath();
    writeFileSync(
      file,
      JSON.stringify({
        id: "m1",
        chat_jid: chatJid,
        sender_jid: null,
        sender_name: "Updated Name",
        body: "hello",
        type: "text",
        timestamp: 1700000010,
        media_mime: null,
        media_path: null,
        quoted_id: null,
        is_from_me: 0,
      }) + "\n"
    );

    const result = importMod.importMessagesJsonl(file, { mode: "merge" });
    assert.equal(result.imported, 1);

    const row = store.getMessage("m1");
    assert.ok(row);
    // raw / media crypto absent from the import must survive untouched.
    assert.equal(row?.raw, '{"key":{"id":"m1"}}');
    assert.equal(row?.media_file_sha256, "abc123");
    // Fields the import did carry are applied.
    assert.equal(row?.sender_name, "Updated Name");
  });

  it("skip mode leaves existing rows untouched", () => {
    const chatJid = "2@s.whatsapp.net";
    seedMessage({ id: "s1", chat_jid: chatJid, timestamp: 1700000020, body: "original", sender_name: "Original Name" });

    const file = tmpJsonlPath();
    writeFileSync(
      file,
      JSON.stringify({
        id: "s1",
        chat_jid: chatJid,
        sender_jid: null,
        sender_name: "Should Not Apply",
        body: "should not apply",
        type: "text",
        timestamp: 1700000020,
        media_mime: null,
        media_path: null,
        quoted_id: null,
        is_from_me: 0,
      }) + "\n"
    );

    const result = importMod.importMessagesJsonl(file, { mode: "skip" });
    assert.equal(result.imported, 0);
    assert.equal(result.skipped, 1);
    assert.equal(result.invalid, 0);

    const row = store.getMessage("s1");
    assert.equal(row?.body, "original");
    assert.equal(row?.sender_name, "Original Name");
  });

  it("counts an invalid row (missing id) as invalid, not inserted", () => {
    const file = tmpJsonlPath();
    const lines = [
      JSON.stringify({ chat_jid: "3@s.whatsapp.net", type: "text", timestamp: 1700000030, body: "no id here" }),
      JSON.stringify({ id: "v1", chat_jid: "3@s.whatsapp.net", type: "text", timestamp: 1700000031, body: "valid row" }),
      "not even json",
      JSON.stringify({ id: "v2", chat_jid: "3@s.whatsapp.net", type: "text" }), // missing timestamp
    ];
    writeFileSync(file, lines.join("\n") + "\n");

    const result = importMod.importMessagesJsonl(file);
    assert.equal(result.imported, 1);
    assert.equal(result.invalid, 3);
    assert.equal(result.skipped, 0);

    assert.ok(store.getMessage("v1"));
    assert.equal(store.getMessage("v2"), undefined);
    assert.equal(store.getMessageCount(), 1);
  });
});
