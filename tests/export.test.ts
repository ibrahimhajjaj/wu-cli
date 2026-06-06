import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mediaLabel } from "../src/core/export.js";
import { serializeWAMessage } from "../src/core/store.js";

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
