import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertSafeMsgId, assertWithin } from "../src/core/media.js";

describe("media path safety", () => {
  it("accepts normal WhatsApp ids", () => {
    assert.doesNotThrow(() => assertSafeMsgId("3EB0C767D82B0F1A2B3C"));
  });
  it("rejects ids with path separators", () => {
    assert.throws(() => assertSafeMsgId("../../etc/passwd"));
    assert.throws(() => assertSafeMsgId("a/b"));
    assert.throws(() => assertSafeMsgId(""));
  });
  it("accepts a child inside the parent dir", () => {
    assert.doesNotThrow(() => assertWithin("/tmp/m", "/tmp/m/abc.jpg"));
  });
  it("rejects a path escaping the parent dir", () => {
    assert.throws(() => assertWithin("/tmp/m", "/tmp/evil.jpg"));
    assert.throws(() => assertWithin("/tmp/m", "/tmp/m/../evil.jpg"));
  });
});
