import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WuConfigSchema } from "../src/config/schema.js";
import {
  resolveConstraint,
  assertCanSend,
  shouldCollect,
} from "../src/core/constraints.js";

describe("resolveConstraint", () => {
  it("should return none when no constraints section", () => {
    const config = WuConfigSchema.parse({});
    assert.equal(resolveConstraint("anything@g.us", config), "none");
  });

  it("should match exact JID first", () => {
    const config = WuConfigSchema.parse({
      constraints: {
        default: "none",
        chats: {
          "120363XXX@g.us": { mode: "read" },
          "*@g.us": { mode: "none" },
        },
      },
    });
    assert.equal(resolveConstraint("120363XXX@g.us", config), "read");
  });

  it("should fall back to wildcard", () => {
    const config = WuConfigSchema.parse({
      constraints: {
        default: "full",
        chats: {
          "*@g.us": { mode: "read" },
          "*@s.whatsapp.net": { mode: "none" },
        },
      },
    });
    assert.equal(resolveConstraint("somegroup@g.us", config), "read");
    assert.equal(resolveConstraint("12345@s.whatsapp.net", config), "none");
  });

  it("should fall back to default", () => {
    const config = WuConfigSchema.parse({
      constraints: {
        default: "read",
        chats: {},
      },
    });
    assert.equal(resolveConstraint("anything@g.us", config), "read");
    assert.equal(resolveConstraint("anything@s.whatsapp.net", config), "read");
  });

  it("should prioritize exact > wildcard > default", () => {
    const config = WuConfigSchema.parse({
      constraints: {
        default: "none",
        chats: {
          "special@g.us": { mode: "full" },
          "*@g.us": { mode: "read" },
        },
      },
    });
    assert.equal(resolveConstraint("special@g.us", config), "full");
    assert.equal(resolveConstraint("other@g.us", config), "read");
    assert.equal(resolveConstraint("dm@s.whatsapp.net", config), "none");
  });
});

describe("assertCanSend", () => {
  it("should not throw for full mode", () => {
    const config = WuConfigSchema.parse({
      constraints: {
        default: "full",
      },
    });
    assert.doesNotThrow(() => assertCanSend("any@g.us", config));
  });

  it("should throw for read mode", () => {
    const config = WuConfigSchema.parse({
      constraints: {
        default: "read",
      },
    });
    assert.throws(
      () => assertCanSend("any@g.us", config),
      /read-only/
    );
  });

  it("should throw for none mode", () => {
    const config = WuConfigSchema.parse({
      constraints: {
        default: "none",
      },
    });
    assert.throws(
      () => assertCanSend("any@g.us", config),
      /blocked/
    );
  });
});

describe("shouldCollect", () => {
  it("should return true for full and read", () => {
    const config = WuConfigSchema.parse({
      constraints: {
        default: "read",
      },
    });
    assert.equal(shouldCollect("any@g.us", config), true);
  });

  it("should return false for none", () => {
    const config = WuConfigSchema.parse({
      constraints: {
        default: "none",
      },
    });
    assert.equal(shouldCollect("any@g.us", config), false);
  });

  it("should respect exact override", () => {
    const config = WuConfigSchema.parse({
      constraints: {
        default: "none",
        chats: {
          "allowed@g.us": { mode: "read" },
        },
      },
    });
    assert.equal(shouldCollect("allowed@g.us", config), true);
    assert.equal(shouldCollect("blocked@g.us", config), false);
  });
});
