import Database from "better-sqlite3";
import { DB_PATH } from "../config/paths.js";
import { loadConfig } from "../config/schema.js";
import { migrate } from "./migrations.js";

let _db: Database.Database | undefined;

export function getDb(): Database.Database {
  if (!_db) {
    const config = loadConfig();
    const dbPath = config.db.path || DB_PATH;
    _db = new Database(dbPath);
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
    _db.pragma("busy_timeout = 5000");
    migrate(_db);
  }
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = undefined;
  }
}
