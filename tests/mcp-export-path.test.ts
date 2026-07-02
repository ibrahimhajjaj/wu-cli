import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, sep } from "path";
import { resolveExportPath } from "../src/mcp/tools.js";

const BASE = join(sep, "home", "wu", "exports");

describe("resolveExportPath", () => {
  it("resolves a relative output under the base dir", () => {
    const result = resolveExportPath("chat.jsonl", BASE);
    assert.equal(result, join(BASE, "chat.jsonl"));
  });

  it("resolves a nested relative output under the base dir", () => {
    const result = resolveExportPath("sub/dir/chat.jsonl", BASE);
    assert.equal(result, join(BASE, "sub", "dir", "chat.jsonl"));
  });

  it("allows an absolute path inside the base dir", () => {
    const result = resolveExportPath(join(BASE, "chat.jsonl"), BASE);
    assert.equal(result, join(BASE, "chat.jsonl"));
  });

  it("rejects a relative traversal that escapes the base dir", () => {
    assert.throws(() => resolveExportPath("../../etc/passwd", BASE));
  });

  it("rejects an absolute path outside the base dir", () => {
    assert.throws(() => resolveExportPath(join(sep, "etc", "passwd"), BASE));
  });
});
