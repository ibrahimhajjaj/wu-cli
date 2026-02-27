import { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { LOCK_PATH } from "../config/paths.js";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireLock(): void {
  if (existsSync(LOCK_PATH)) {
    const existingPid = parseInt(readFileSync(LOCK_PATH, "utf-8").trim(), 10);
    if (!isNaN(existingPid) && isProcessAlive(existingPid)) {
      throw new Error(
        `Another wu process is running (PID ${existingPid}). Only one long-running connection is allowed at a time.`
      );
    }
    // Stale lock file — remove it
    unlinkSync(LOCK_PATH);
  }
  writeFileSync(LOCK_PATH, String(process.pid), "utf-8");
}

export function releaseLock(): void {
  try {
    if (existsSync(LOCK_PATH)) {
      const pid = parseInt(readFileSync(LOCK_PATH, "utf-8").trim(), 10);
      if (pid === process.pid) {
        unlinkSync(LOCK_PATH);
      }
    }
  } catch {
    // Ignore errors during cleanup
  }
}
