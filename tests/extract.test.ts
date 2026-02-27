import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractText,
  extractMessageType,
  extractQuotedId,
  extractLocationData,
  extractMediaInfo,
} from "../src/core/extract.js";

// Fixture WAMessage content objects (matching Baileys proto.IMessage shape)

describe("extractText", () => {
  it("should extract conversation text", () => {
    assert.equal(extractText({ conversation: "hello world" }), "hello world");
  });

  it("should extract extended text message", () => {
    assert.equal(
      extractText({ extendedTextMessage: { text: "quoted reply" } }),
      "quoted reply"
    );
  });

  it("should extract image caption", () => {
    assert.equal(
      extractText({
        imageMessage: { caption: "nice photo", mimetype: "image/jpeg" },
      } as any),
      "nice photo"
    );
  });

  it("should extract video caption", () => {
    assert.equal(
      extractText({
        videoMessage: { caption: "cool video", mimetype: "video/mp4" },
      } as any),
      "cool video"
    );
  });

  it("should extract poll creation", () => {
    const text = extractText({
      pollCreationMessage: {
        name: "Lunch?",
        options: [{ optionName: "Pizza" }, { optionName: "Sushi" }],
      },
    } as any);
    assert.ok(text?.includes("Lunch?"));
    assert.ok(text?.includes("Pizza"));
    assert.ok(text?.includes("Sushi"));
  });

  it("should extract contact vcard", () => {
    assert.equal(
      extractText({
        contactMessage: { vcard: "BEGIN:VCARD\nFN:John\nEND:VCARD", displayName: "John" },
      } as any),
      "BEGIN:VCARD\nFN:John\nEND:VCARD"
    );
  });

  it("should extract reaction text", () => {
    assert.equal(
      extractText({ reactionMessage: { text: "👍" } } as any),
      "👍"
    );
  });

  it("should extract location name", () => {
    assert.equal(
      extractText({
        locationMessage: {
          degreesLatitude: 40.7,
          degreesLongitude: -74.0,
          name: "New York",
        },
      } as any),
      "New York"
    );
  });

  it("should return null for empty content", () => {
    assert.equal(extractText(undefined), null);
    assert.equal(extractText({}), null);
  });
});

describe("extractMessageType", () => {
  it("should identify text messages", () => {
    assert.equal(extractMessageType({ conversation: "hi" }), "text");
    assert.equal(
      extractMessageType({ extendedTextMessage: { text: "hi" } }),
      "text"
    );
  });

  it("should identify image messages", () => {
    assert.equal(
      extractMessageType({ imageMessage: { mimetype: "image/jpeg" } } as any),
      "image"
    );
  });

  it("should identify video messages", () => {
    assert.equal(
      extractMessageType({ videoMessage: { mimetype: "video/mp4" } } as any),
      "video"
    );
  });

  it("should identify audio messages", () => {
    assert.equal(
      extractMessageType({ audioMessage: { mimetype: "audio/ogg" } } as any),
      "audio"
    );
  });

  it("should identify document messages", () => {
    assert.equal(
      extractMessageType({
        documentMessage: { mimetype: "application/pdf" },
      } as any),
      "document"
    );
  });

  it("should identify sticker messages", () => {
    assert.equal(
      extractMessageType({ stickerMessage: { mimetype: "image/webp" } } as any),
      "sticker"
    );
  });

  it("should identify contact messages", () => {
    assert.equal(
      extractMessageType({ contactMessage: { vcard: "..." } } as any),
      "contact"
    );
  });

  it("should identify location messages", () => {
    assert.equal(
      extractMessageType({
        locationMessage: { degreesLatitude: 0, degreesLongitude: 0 },
      } as any),
      "location"
    );
  });

  it("should identify reaction messages", () => {
    assert.equal(
      extractMessageType({ reactionMessage: { text: "👍" } } as any),
      "reaction"
    );
  });

  it("should identify poll messages", () => {
    assert.equal(
      extractMessageType({
        pollCreationMessage: { name: "Q?", options: [] },
      } as any),
      "poll"
    );
  });

  it("should return unknown for empty content", () => {
    assert.equal(extractMessageType(undefined), "unknown");
    assert.equal(extractMessageType({}), "unknown");
  });
});

describe("extractQuotedId", () => {
  it("should extract quoted message ID from extended text", () => {
    assert.equal(
      extractQuotedId({
        extendedTextMessage: {
          text: "reply",
          contextInfo: { stanzaId: "msg123" },
        },
      } as any),
      "msg123"
    );
  });

  it("should extract quoted ID from image message", () => {
    assert.equal(
      extractQuotedId({
        imageMessage: {
          mimetype: "image/jpeg",
          contextInfo: { stanzaId: "msg456" },
        },
      } as any),
      "msg456"
    );
  });

  it("should return null when no quote", () => {
    assert.equal(extractQuotedId({ conversation: "hi" }), null);
    assert.equal(extractQuotedId(undefined), null);
  });
});

describe("extractLocationData", () => {
  it("should extract location coordinates", () => {
    const loc = extractLocationData({
      locationMessage: {
        degreesLatitude: 40.7128,
        degreesLongitude: -74.006,
        name: "NYC",
      },
    } as any);
    assert.deepEqual(loc, { lat: 40.7128, lon: -74.006, name: "NYC" });
  });

  it("should extract live location", () => {
    const loc = extractLocationData({
      liveLocationMessage: {
        degreesLatitude: 51.5,
        degreesLongitude: -0.1,
      },
    } as any);
    assert.ok(loc);
    assert.equal(loc!.lat, 51.5);
  });

  it("should return null for non-location", () => {
    assert.equal(extractLocationData({ conversation: "hi" }), null);
    assert.equal(extractLocationData(undefined), null);
  });
});

describe("extractMediaInfo", () => {
  it("should extract image media info", () => {
    const info = extractMediaInfo({
      imageMessage: { mimetype: "image/jpeg", fileLength: 12345 },
    } as any);
    assert.deepEqual(info, { mime: "image/jpeg", size: 12345 });
  });

  it("should extract document media info", () => {
    const info = extractMediaInfo({
      documentMessage: { mimetype: "application/pdf", fileLength: 99999 },
    } as any);
    assert.deepEqual(info, { mime: "application/pdf", size: 99999 });
  });

  it("should return null for text messages", () => {
    assert.equal(extractMediaInfo({ conversation: "hi" }), null);
    assert.equal(extractMediaInfo(undefined), null);
  });
});
