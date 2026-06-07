import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDuration } from "../src/core/media.js";

describe("parseDuration", () => {
  it("parses units", () => {
    assert.equal(parseDuration("30d"), 30 * 86400);
    assert.equal(parseDuration("12h"), 12 * 3600);
    assert.equal(parseDuration("2w"), 2 * 604800);
    assert.equal(parseDuration("45m"), 45 * 60);
    assert.equal(parseDuration("90s"), 90);
  });
  it("treats bare numbers as days", () => {
    assert.equal(parseDuration("7"), 7 * 86400);
  });
  it("tolerates whitespace", () => {
    assert.equal(parseDuration(" 30d "), 30 * 86400);
  });
  it("returns null on garbage", () => {
    assert.equal(parseDuration("soon"), null);
    assert.equal(parseDuration("30x"), null);
    assert.equal(parseDuration(""), null);
  });
});
