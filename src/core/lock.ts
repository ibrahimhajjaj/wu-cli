import { readFileSync, writeFileSync, unlinkSync, existsSync, openSync, closeSync } from "fs";
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
  try {
    unlinkSync(LOCK_PATH);
  } catch {
    // Another process cleaned it first
  }
  return { locked: false };
}

export function acquireLock(): void {
  const write = () => {
    const fd = openSync(LOCK_PATH, "wx");
    try {
      writeFileSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
  };

  try {
    write();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const check = isLocked();
    if (check.locked) {
      throw new Error(
        `Another wu process is running (PID ${check.pid}). Stop it first:\n\n  kill ${check.pid} && rm ~/.wu/wu.lock`,
        { cause: err }
      );
    }
    write();
  }
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
