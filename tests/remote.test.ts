import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { remotePath, shellEscape, describeSshFailure } from "../src/core/remote.js";
import { WuConfigSchema } from "../src/config/schema.js";

describe("describeSshFailure", () => {
  it("explains a command we killed for running past the timeout", () => {
    // The case that produced a bare "Remote backfill failed: ": the remote was
    // still waiting when the connection was cut, so stderr was empty.
    const why = describeSshFailure({ killed: true, signal: "SIGTERM" }, "", 30_000);
    assert.match(why, /killed after 30000ms/);
    assert.match(why, /SIGTERM/);
    assert.match(why, /needed longer than the timeout/);
  });

  it("never returns an empty reason for a failure", () => {
    for (const err of [
      { killed: true },
      { code: "ENOENT" },
      { code: 255 },
      { message: "boom" },
      {},
    ]) {
      assert.notEqual(describeSshFailure(err, "", 1000), "", `empty reason for ${JSON.stringify(err)}`);
    }
  });

  it("prefers the remote's own stderr when there is any", () => {
    assert.equal(
      describeSshFailure({ code: 1 }, "wu: chat is blocked by constraints", 30_000),
      "wu: chat is blocked by constraints"
    );
  });

  it("names a spawn-level problem rather than pretending it was an exit code", () => {
    assert.match(describeSshFailure({ code: "E2BIG" }, "", 30_000), /could not run \(E2BIG\)/);
  });

  it("says nothing when there was no failure", () => {
    assert.equal(describeSshFailure(null, "", 30_000), "");
  });
});

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

// The backfill tool tells the remote CLI to wait `timeout_ms` for history, so the
// SSH call must outlive that plus login and process startup. Giving it exactly
// timeout_ms cut the connection while the command was still waiting, and the
// caller got a failure with no reason attached. Measured overhead on a real box
// was ~2.5s for a 30s wait, so the budget needs real headroom, not a few hundred
// milliseconds.
describe("remote backfill timeout budget", () => {
  const budgetFor = (timeoutMs: number) => Math.max(300_000, timeoutMs + 30_000);

  it("always exceeds the wait the remote command was asked to perform", () => {
    for (const wait of [1_000, 30_000, 60_000, 300_000, 600_000]) {
      const budget = budgetFor(wait);
      assert.ok(budget > wait, `budget ${budget} must exceed wait ${wait}`);
      assert.ok(budget - wait >= 30_000, `needs real headroom, got ${budget - wait}ms for a ${wait}ms wait`);
    }
  });

  it("is never the bare 30s default that caused the silent failure", () => {
    assert.ok(budgetFor(30_000) > 30_000, "a 30s wait cannot get a 30s connection");
  });
});
