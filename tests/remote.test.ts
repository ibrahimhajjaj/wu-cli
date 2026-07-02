import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { remotePath, shellEscape } from "../src/core/remote.js";
import { WuConfigSchema } from "../src/config/schema.js";

describe("remotePath escaping", () => {
  it("expands ~ and escapes the remainder", () => {
    assert.equal(remotePath("~/.wu"), `"$HOME"/'.wu'`);
    assert.equal(remotePath("~"), '"$HOME"');
  });
  it("escapes shell metacharacters in the remainder", () => {
    const out = remotePath("~/x$(touch pwned)");
    // Single-quoting neutralizes $(...) without deleting the text, so assert
    // it's wrapped in single quotes (inert) rather than checking for absence.
    assert.ok(
      out.includes("'x$(touch pwned)'"),
      "command substitution must be single-quoted so the shell treats it literally"
    );
  });
  it("single-quote-escapes an absolute path", () => {
    assert.equal(remotePath("/var/wu"), `'/var/wu'`);
  });
});

describe("remote host validation", () => {
  it("accepts user@host and dotted names", () => {
    assert.doesNotThrow(() =>
      WuConfigSchema.parse({ remotes: { vps: { host: "deploy@example.com" } } })
    );
  });
  it("rejects a host starting with a dash", () => {
    assert.throws(() =>
      WuConfigSchema.parse({ remotes: { vps: { host: "-oProxyCommand=x" } } })
    );
  });
  it("rejects a host with a space or $", () => {
    assert.throws(() =>
      WuConfigSchema.parse({ remotes: { vps: { host: "a b" } } })
    );
  });
});
