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
      if (currentVersion < 2) {
        applyV2(db);
      }
      db.prepare("INSERT INTO _migrations (version) VALUES (?)").run(
        SCHEMA_VERSION
      );
    })();
  }
}

function applyV2(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(chats)").all() as Array<{ name: string }>;
  const has = (n: string) => cols.some((c) => c.name === n);
  if (!has("last_seen_at")) db.exec("ALTER TABLE chats ADD COLUMN last_seen_at INTEGER");
  if (!has("is_community")) db.exec("ALTER TABLE chats ADD COLUMN is_community INTEGER DEFAULT 0");
  if (!has("is_community_announce")) db.exec("ALTER TABLE chats ADD COLUMN is_community_announce INTEGER DEFAULT 0");
  if (!has("linked_parent")) db.exec("ALTER TABLE chats ADD COLUMN linked_parent TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_chats_linked_parent ON chats(linked_parent) WHERE linked_parent IS NOT NULL");
  db.exec("CREATE INDEX IF NOT EXISTS idx_chats_type ON chats(type)");
}
