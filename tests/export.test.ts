import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mediaLabel, writeManifest, quotedSnippet, type ManifestRow } from "../src/core/export.js";
import { serializeWAMessage } from "../src/core/store.js";
import { readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

function raw(message: unknown): string {
  return serializeWAMessage({ key: { id: "x" }, message });
}

describe("mediaLabel", () => {
  it("labels image/video/sticker plainly", () => {
    assert.equal(mediaLabel({ type: "image", media_mime: "image/jpeg", raw: null }), "[image]");
    assert.equal(mediaLabel({ type: "video", media_mime: "video/mp4", raw: null }), "[video]");
    assert.equal(mediaLabel({ type: "sticker", media_mime: "image/webp", raw: null }), "[sticker]");
  });

  it("includes document filename from raw", () => {
    const r = raw({ documentMessage: { fileName: "scholarship.pdf", mimetype: "application/pdf" } });
    assert.equal(mediaLabel({ type: "document", media_mime: "application/pdf", raw: r }), "[document: scholarship.pdf]");
  });

  it("falls back to [document] without filename", () => {
    assert.equal(mediaLabel({ type: "document", media_mime: "application/pdf", raw: null }), "[document]");
  });

  it("distinguishes voice notes from audio and shows duration", () => {
    const voice = raw({ audioMessage: { ptt: true, seconds: 42, mimetype: "audio/ogg" } });
    assert.equal(mediaLabel({ type: "audio", media_mime: "audio/ogg", raw: voice }), "[voice 0:42]");
    const music = raw({ audioMessage: { ptt: false, seconds: 125, mimetype: "audio/mpeg" } });
    assert.equal(mediaLabel({ type: "audio", media_mime: "audio/mpeg", raw: music }), "[audio 2:05]");
  });

  it("labels poll/contact/location/deleted", () => {
    assert.equal(mediaLabel({ type: "poll", media_mime: null, raw: null }), "[poll]");
    assert.equal(mediaLabel({ type: "contact", media_mime: null, raw: null }), "[contact]");
    assert.equal(mediaLabel({ type: "location", media_mime: null, raw: null }), "[location]");
    assert.equal(mediaLabel({ type: "deleted", media_mime: null, raw: null }), "[deleted]");
  });

  it("falls back to bracketed type for unknown", () => {
    assert.equal(mediaLabel({ type: "unknown", media_mime: null, raw: null }), "[unknown]");
  });

  it("labels system/edited and counts album items", () => {
    assert.equal(mediaLabel({ type: "system", media_mime: null, raw: null }), "[event]");
    assert.equal(mediaLabel({ type: "edited", media_mime: null, raw: null }), "[edited]");
    const album = raw({ albumMessage: { expectedImageCount: 2, expectedVideoCount: 1 } });
    assert.equal(mediaLabel({ type: "album", media_mime: null, raw: album }), "[album: 3 items]");
  });
});

describe("quotedSnippet", () => {
  it("uses sender name and clips long bodies at 60 chars", () => {
    const s = quotedSnippet({
      sender_name: "Ali", sender_jid: "1@s.whatsapp.net", type: "text",
      media_mime: null, raw: null, body: "x".repeat(80),
    });
    assert.equal(s, `Ali: ${"x".repeat(60)}…`);
  });

  it("collapses newlines in the quoted body", () => {
    const s = quotedSnippet({
      sender_name: null, sender_jid: "2@s.whatsapp.net", type: "text",
      media_mime: null, raw: null, body: "line one\nline two",
    });
    assert.equal(s, "2@s.whatsapp.net: line one line two");
  });

  it("falls back to the media label when there is no body", () => {
    const s = quotedSnippet({
      sender_name: "Dona", sender_jid: null, type: "image",
      media_mime: "image/jpeg", raw: null, body: null,
    });
    assert.equal(s, "Dona: [image]");
  });
});

describe("writeManifest", () => {
  it("writes one json object per line", () => {
    const path = join(tmpdir(), `wu-manifest-${process.pid}.jsonl`);
    const rows: ManifestRow[] = [
      { msgId: "A", type: "image", sender: "Ali", timestamp: 100, caption: "flyer", local_path: "/m/A.jpg", ocr_text: "IELTS exemption", transcript: null },
      { msgId: "B", type: "audio", sender: null, timestamp: 200, caption: null, local_path: "/m/B.ogg", ocr_text: null, transcript: "deadline is friday" },
    ];
    try {
      writeManifest(path, rows);
      const lines = readFileSync(path, "utf-8").trimEnd().split("\n");
      assert.equal(lines.length, 2);
      assert.deepEqual(JSON.parse(lines[0]), rows[0]);
      assert.deepEqual(JSON.parse(lines[1]), rows[1]);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("writes an empty file for no rows", () => {
    const path = join(tmpdir(), `wu-manifest-empty-${process.pid}.jsonl`);
    try {
      writeManifest(path, []);
      assert.equal(readFileSync(path, "utf-8"), "");
    } finally {
      rmSync(path, { force: true });
    }
  });
});
