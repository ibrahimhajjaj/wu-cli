import type Database from "better-sqlite3";
import { CREATE_TABLES_SQL, SCHEMA_VERSION } from "./schema.js";

const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS _migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER DEFAULT (unixepoch())
);
`;

export function migrate(db: Database.Database): void {
  db.exec(MIGRATIONS_TABLE);

  const current = db
    .prepare("SELECT MAX(version) as v FROM _migrations")
    .get() as { v: number | null } | undefined;

  const currentVersion = current?.v ?? 0;

  if (currentVersion < SCHEMA_VERSION) {
    db.transaction(() => {
      if (currentVersion < 1) {
        db.exec(CREATE_TABLES_SQL);
      }
      db.prepare("INSERT INTO _migrations (version) VALUES (?)").run(
        SCHEMA_VERSION
      );
    })();
  }
}
