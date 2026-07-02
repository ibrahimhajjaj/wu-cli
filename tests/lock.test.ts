import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// LOCK_PATH is derived from WU_HOME at module-load time, so the override has
// to land before paths.js (and anything that imports it) is ever imported.
// Node's test runner isolates each file into its own process, so this env
// var only needs to be correct for this file.
const wuHome = mkdtempSync(join(tmpdir(), "wu-lock-test-"));
process.env.WU_HOME = wuHome;

const { LOCK_PATH } = await import("../src/config/paths.js");
const { acquireLock, releaseLock, isLocked } = await import("../src/core/lock.js");

describe("daemon lock", () => {
  after(() => {
    try { rmSync(wuHome, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("acquires cleanly when nothing holds the lock", () => {
    acquireLock();
    assert.equal(existsSync(LOCK_PATH), true);
    releaseLock();
    assert.equal(existsSync(LOCK_PATH), false);
  });

  it("throws on a double acquire from the same live process", () => {
    acquireLock();
    assert.throws(() => acquireLock(), /Another wu process is running/);
    releaseLock();
  });

  it("allows re-acquiring after release", () => {
    acquireLock();
    releaseLock();
    acquireLock();
    releaseLock();
  });

  it("reclaims a stale lock left by a dead pid", () => {
    // PID 4194304 is above Linux's default pid_max and macOS's PID ceiling,
    // so it reliably does not correspond to a live process.
    const deadPid = 4194304;
    writeFileSync(LOCK_PATH, String(deadPid), "utf-8");
    const status = isLocked();
    assert.equal(status.locked, false);
    assert.equal(existsSync(LOCK_PATH), false);

    acquireLock();
    assert.equal(existsSync(LOCK_PATH), true);
    releaseLock();
  });
});
