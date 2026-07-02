import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { makeFakeSocket } from "./helpers/fake-socket.js";

// Same singleton-DB redirection pattern as tests/fts-recovery.test.ts and
// tests/listener.test.ts - sendReaction/deleteForEveryone/sendText(replyTo)
// all read the message store.
const home = mkdtempSync(join(tmpdir(), "wu-sender-"));
process.env.WU_HOME = home;
mkdirSync(join(home, "auth"), { recursive: true });

let store: typeof import("../src/core/store.js");
let database: typeof import("../src/db/database.js");
let sender: typeof import("../src/core/sender.js");
let schema: typeof import("../src/config/schema.js");

before(async () => {
  database = await import("../src/db/database.js");
  store = await import("../src/core/store.js");
  sender = await import("../src/core/sender.js");
  schema = await import("../src/config/schema.js");
  database.getDb();
});

after(() => {
  database.closeDb();
  rmSync(home, { recursive: true, force: true });
});

// send_delay_ms defaults to 1000; tests set it to 0 to stay fast (plan
// note in 011). A dedicated test below exercises the delay itself.
function fullConfig() {
  return schema.WuConfigSchema.parse({
    constraints: { default: "full" },
    whatsapp: { send_delay_ms: 0 },
  });
}

describe("sendText", () => {
  it("calls sock.sendMessage with a text payload", async () => {
    const { sock, calls } = makeFakeSocket();
    const result = await sender.sendText(sock, "123@g.us", "hi there", fullConfig());

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "sendMessage");
    assert.deepEqual(calls[0]!.args, ["123@g.us", { text: "hi there" }, {}]);
    assert.equal(result!.key!.id, "fake-msg-id");
  });

  it("resolves replyTo to the stored raw message as `quoted`", async () => {
    store.upsertMessage({
      id: "quoted-1",
      chat_jid: "123@g.us",
      sender_jid: "999@s.whatsapp.net",
      sender_name: "Bob",
      body: "original message",
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
      timestamp: 1700000000,
      raw: store.serializeWAMessage({ key: { id: "quoted-1" }, message: { conversation: "original message" } }),
    });

    const { sock, calls } = makeFakeSocket();
    await sender.sendText(sock, "123@g.us", "a reply", fullConfig(), { replyTo: "quoted-1" });

    assert.equal(calls.length, 1);
    const sendOpts = calls[0]!.args[2] as { quoted?: unknown };
    assert.ok(sendOpts.quoted, "quoted should be attached when replyTo resolves");
    assert.deepEqual(sendOpts.quoted, { key: { id: "quoted-1" }, message: { conversation: "original message" } });
  });

  it("omits quoted when replyTo does not resolve to a stored message", async () => {
    const { sock, calls } = makeFakeSocket();
    await sender.sendText(sock, "123@g.us", "a reply", fullConfig(), { replyTo: "does-not-exist" });

    assert.deepEqual(calls[0]!.args[2], {});
  });

  it("throws a constraint violation for a read-only chat and does not call sendMessage", async () => {
    const { sock, calls } = makeFakeSocket();
    const readOnly = schema.WuConfigSchema.parse({ constraints: { default: "read" } });

    await assert.rejects(
      () => sender.sendText(sock, "123@g.us", "hi", readOnly),
      /read-only/
    );
    assert.equal(calls.length, 0);
  });

  it("respects send_delay_ms between consecutive sends", async () => {
    const { sock } = makeFakeSocket();
    const delayed = schema.WuConfigSchema.parse({
      constraints: { default: "full" },
      whatsapp: { send_delay_ms: 120 },
    });

    await sender.sendText(sock, "123@g.us", "first", delayed);
    const start = Date.now();
    await sender.sendText(sock, "123@g.us", "second", delayed);
    const elapsed = Date.now() - start;

    assert.ok(elapsed >= 90, `expected the second send to be rate-limited (~120ms), got ${elapsed}ms`);
  });
});

describe("sendMedia", () => {
  it("sends an image with the inferred mimetype", async () => {
    const { sock, calls } = makeFakeSocket();
    const filePath = join(home, "photo.jpg");
    writeFileSync(filePath, Buffer.from("fake-jpeg-bytes"));

    await sender.sendMedia(sock, "123@g.us", filePath, fullConfig(), { caption: "look" });

    assert.equal(calls.length, 1);
    const [jid, content] = calls[0]!.args as [string, Record<string, unknown>];
    assert.equal(jid, "123@g.us");
    assert.equal(content.mimetype, "image/jpeg");
    assert.equal(content.caption, "look");
    assert.ok(Buffer.isBuffer(content.image));
  });

  it("sends a voice note as ptt for .opus", async () => {
    const { sock, calls } = makeFakeSocket();
    const filePath = join(home, "note.opus");
    writeFileSync(filePath, Buffer.from("fake-opus-bytes"));

    await sender.sendMedia(sock, "123@g.us", filePath, fullConfig());

    const content = calls[0]!.args[1] as Record<string, unknown>;
    assert.equal(content.ptt, true);
    assert.equal(content.mimetype, "audio/ogg; codecs=opus");
  });

  it("falls back to application/octet-stream and document content for unknown extensions", async () => {
    const { sock, calls } = makeFakeSocket();
    const filePath = join(home, "mystery.xyz");
    writeFileSync(filePath, Buffer.from("???"));

    await sender.sendMedia(sock, "123@g.us", filePath, fullConfig());

    const content = calls[0]!.args[1] as Record<string, unknown>;
    assert.equal(content.mimetype, "application/octet-stream");
    assert.equal(content.fileName, "mystery.xyz");
    assert.ok(Buffer.isBuffer(content.document));
  });
});

describe("sendReaction", () => {
  it("builds the reaction key with fromMe from the stored message", async () => {
    store.upsertMessage({
      id: "react-target",
      chat_jid: "123@g.us",
      sender_jid: null,
      sender_name: null,
      body: "hi",
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
      is_from_me: 1,
      timestamp: 1700000000,
      raw: "{}",
    });

    const { sock, calls } = makeFakeSocket();
    await sender.sendReaction(sock, "123@g.us", "react-target", "\u{1F44D}", fullConfig());

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.args, [
      "123@g.us",
      { react: { text: "\u{1F44D}", key: { remoteJid: "123@g.us", id: "react-target", fromMe: true } } },
    ]);
  });

  it("defaults fromMe to false when the message is not stored", async () => {
    const { sock, calls } = makeFakeSocket();
    await sender.sendReaction(sock, "123@g.us", "unknown-msg", "\u{1F44D}", fullConfig());

    const [, payload] = calls[0]!.args as [string, { react: { key: { fromMe: boolean } } }];
    assert.equal(payload.react.key.fromMe, false);
  });
});

describe("deleteForEveryone", () => {
  it("sends a delete payload keyed off the stored message", async () => {
    const { sock, calls } = makeFakeSocket();
    await sender.deleteForEveryone(sock, "123@g.us", "to-delete", fullConfig());

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.args, [
      "123@g.us",
      { delete: { remoteJid: "123@g.us", id: "to-delete", fromMe: false } },
    ]);
  });
});
