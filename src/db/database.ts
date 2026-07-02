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

// Prepared statements are bound to the handle that created them, so caching
// them keyed by that handle (rather than a flat map) means a `reloadDb()`
// swap naturally starts every caller off with a fresh statement instead of
// one pointing at a closed database. The old handle's sub-map is dropped
// (and eventually GC'd) once nothing references it anymore.
let _stmtCache = new WeakMap<Database.Database, Map<string, Database.Statement>>();

/** Prepare `sql` once per db handle and reuse it on subsequent calls. Only
 * use this for a fixed, bounded set of SQL strings - each distinct string
 * gets its own cache entry, so building SQL from unbounded caller input here
 * would leak memory. */
export function prepareCached(sql: string): Database.Statement {
  const db = getDb();
  let stmts = _stmtCache.get(db);
  if (!stmts) {
    stmts = new Map();
    _stmtCache.set(db, stmts);
  }
  let stmt = stmts.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    stmts.set(sql, stmt);
  }
  return stmt;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = undefined;
  }
  _stmtCache = new WeakMap();
}

/** Close and reopen the DB (e.g. after sync replaces the file on disk) */
export function reloadDb(): void {
  closeDb();
  // Next getDb() call will reopen with the new file
}
