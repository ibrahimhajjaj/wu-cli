import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { WASocket } from "@whiskeysockets/baileys";

// LOCK_PATH is frozen from WU_HOME at module load, so redirect before importing.
const wuHome = mkdtempSync(join(tmpdir(), "wu-conn-guard-"));
process.env.WU_HOME = wuHome;

const { LOCK_PATH } = await import("../src/config/paths.js");
const { releaseLock } = await import("../src/core/lock.js");
const { withConnection } = await import("../src/core/connection.js");

// A pid that is alive but is not us, so isLocked() reports the lock as held by
// another process. The parent of this test process fits and needs no spawning.
const otherPid = process.ppid;

describe("withConnection lock guard", () => {
  after(() => {
    try { releaseLock(); } catch { /* best effort */ }
    try { rmSync(wuHome, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("refuses an exclusive connection while another process holds the lock", async () => {
    // Simulate a different live process holding the lock: the guard ignores our
    // own pid so a lock-owning process is never blocked by itself.
    writeFileSync(LOCK_PATH, String(otherPid));
    let ran = false;
    try {
      await assert.rejects(
        () =>
          withConnection(
            async () => {
              ran = true;
              return null;
            },
            { requireExclusive: true }
          ),
        /holds the WhatsApp session/
      );
      // The point of the guard: no socket was created and the body never ran,
      // so nothing could have written the shared auth files.
      assert.equal(ran, false, "the callback must not run when the lock is held");
    } finally {
      try { unlinkSync(LOCK_PATH); } catch { /* best effort */ }
    }
  });

  it("carries the connection-failed exit code", async () => {
    writeFileSync(LOCK_PATH, String(otherPid));
    try {
      await withConnection(async (_sock: WASocket) => null, { requireExclusive: true });
      assert.fail("expected withConnection to throw");
    } catch (err) {
      assert.equal((err as { exitCode?: number }).exitCode, 4);
    } finally {
      try { unlinkSync(LOCK_PATH); } catch { /* best effort */ }
    }
  });

  it("leaves unguarded callers alone so commands with no daemon route still work", async () => {
    // `messages send` and group management have no IPC equivalent - notably the
    // remote write path SSHes them onto the box where the daemon holds the lock -
    // so they must not be refused here. Reaching createConnection (and failing on
    // credentials in this sandbox) proves the guard did not short-circuit.
    writeFileSync(LOCK_PATH, String(otherPid));
    try {
      await assert.rejects(
        () => withConnection(async () => null),
        (err: Error) => !/holds the WhatsApp session/.test(err.message)
      );
    } finally {
      try { unlinkSync(LOCK_PATH); } catch { /* best effort */ }
    }
  });
});
