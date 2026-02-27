import { mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const WU_HOME = process.env.WU_HOME || join(homedir(), ".wu");
export const AUTH_DIR = join(WU_HOME, "auth");
export const DB_PATH = join(WU_HOME, "wu.db");
export const CONFIG_PATH = join(WU_HOME, "config.yaml");
export const MEDIA_DIR = join(WU_HOME, "media");
export const LOCK_PATH = join(WU_HOME, "wu.lock");

export function ensureWuHome(): void {
  mkdirSync(WU_HOME, { recursive: true });
  mkdirSync(AUTH_DIR, { recursive: true });
  mkdirSync(MEDIA_DIR, { recursive: true });
}
