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

export function isLocked(): { locked: boolean; pid?: number } {
  if (!existsSync(LOCK_PATH)) return { locked: false };
  const existingPid = parseInt(readFileSync(LOCK_PATH, "utf-8").trim(), 10);
  if (!isNaN(existingPid) && isProcessAlive(existingPid)) {
    return { locked: true, pid: existingPid };
  }
  // Stale lock — clean it up
  unlinkSync(LOCK_PATH);
  return { locked: false };
}

export function acquireLock(): void {
  const { locked, pid } = isLocked();
  if (locked) {
    throw new Error(
      `Another wu process is running (PID ${pid}). Stop it first:\n\n  kill ${pid} && rm ~/.wu/wu.lock`
    );
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
