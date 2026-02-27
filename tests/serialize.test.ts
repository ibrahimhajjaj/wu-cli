import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  serializeWAMessage,
  deserializeWAMessage,
} from "../src/core/store.js";

describe("WAMessage serialization", () => {
  it("should round-trip a simple message", () => {
    const msg = {
      key: { id: "abc123", remoteJid: "test@s.whatsapp.net", fromMe: false },
      message: { conversation: "hello" },
      messageTimestamp: 1700000000,
    };
    const raw = serializeWAMessage(msg);
    const parsed = deserializeWAMessage(raw) as typeof msg;
    assert.equal(parsed.key.id, "abc123");
    assert.equal(parsed.message.conversation, "hello");
    assert.equal(parsed.messageTimestamp, 1700000000);
  });

  it("should preserve Uint8Array fields as base64", () => {
    const mediaKey = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const fileSha256 = new Uint8Array([10, 20, 30, 40]);

    const msg = {
      key: { id: "media1" },
      message: {
        imageMessage: {
          mediaKey,
          fileSha256,
          url: "https://example.com/media",
          directPath: "/some/path",
          mimetype: "image/jpeg",
        },
      },
    };

    const raw = serializeWAMessage(msg);

    // Verify it contains base64 markers
    const parsed = JSON.parse(raw);
    assert.equal(parsed.message.imageMessage.mediaKey.__type, "Uint8Array");
    assert.equal(typeof parsed.message.imageMessage.mediaKey.data, "string");

    // Round-trip should restore Uint8Array
    const restored = deserializeWAMessage(raw) as typeof msg;
    const restoredKey = restored.message.imageMessage.mediaKey;
    assert.ok(restoredKey instanceof Uint8Array, "mediaKey should be Uint8Array");
    assert.deepEqual(Array.from(restoredKey), [1, 2, 3, 4, 5, 6, 7, 8]);

    const restoredSha = restored.message.imageMessage.fileSha256;
    assert.ok(restoredSha instanceof Uint8Array, "fileSha256 should be Uint8Array");
    assert.deepEqual(Array.from(restoredSha), [10, 20, 30, 40]);
  });

  it("should handle nested Uint8Array fields", () => {
    const msg = {
      key: { id: "nested" },
      message: {
        documentMessage: {
          mediaKey: new Uint8Array([255, 0, 128]),
          fileSha256: new Uint8Array([42]),
          fileEncSha256: new Uint8Array([1, 2]),
          fileName: "doc.pdf",
        },
      },
    };

    const raw = serializeWAMessage(msg);
    const restored = deserializeWAMessage(raw) as typeof msg;

    assert.ok(restored.message.documentMessage.mediaKey instanceof Uint8Array);
    assert.deepEqual(Array.from(restored.message.documentMessage.mediaKey), [255, 0, 128]);
    assert.equal(restored.message.documentMessage.fileName, "doc.pdf");
  });

  it("should handle messages without Uint8Array fields", () => {
    const msg = {
      key: { id: "text1", remoteJid: "test@s.whatsapp.net" },
      message: { conversation: "plain text" },
    };

    const raw = serializeWAMessage(msg);
    const restored = deserializeWAMessage(raw) as typeof msg;
    assert.equal(restored.message.conversation, "plain text");
  });

  it("should handle null and undefined values", () => {
    const msg = {
      key: { id: "null1" },
      message: null,
      pushName: undefined,
    };

    const raw = serializeWAMessage(msg);
    const restored = deserializeWAMessage(raw) as any;
    assert.equal(restored.key.id, "null1");
    assert.equal(restored.message, null);
  });
});
