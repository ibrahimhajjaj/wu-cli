import type Database from "better-sqlite3";
import type { WAMessage } from "@whiskeysockets/baileys";
import { CREATE_TABLES_SQL, SCHEMA_VERSION } from "./schema.js";
import {
  getMessageContent,
  extractMessageType,
  extractText,
  extractSystemEvent,
} from "../core/extract.js";

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
      if (currentVersion < 3) {
        applyV3(db);
      }
      if (currentVersion < 4) {
        applyV4(db);
      }
      db.prepare("INSERT INTO _migrations (version) VALUES (?)").run(
        SCHEMA_VERSION
      );
    })();
  }
}

// Reclassify already-collected type='unknown' rows by re-deriving the type
// from stored raw: system events (joins/leaves/renames), albums and edits that
// earlier ingestion bucketed as unknown become labelled.
function applyV3(db: Database.Database): void {
  const deserialize = (raw: string): WAMessage =>
    JSON.parse(raw, (_k, v) =>
      v && typeof v === "object" && v.__type === "Uint8Array" && typeof v.data === "string"
        ? new Uint8Array(Buffer.from(v.data, "base64"))
        : v
    ) as WAMessage;

  const rows = db
    .prepare("SELECT id, body, raw FROM messages WHERE type = 'unknown' AND raw IS NOT NULL")
    .all() as Array<{ id: string; body: string | null; raw: string }>;

  const update = db.prepare("UPDATE messages SET type = ?, body = ? WHERE id = ?");

  for (const row of rows) {
    try {
      const msg = deserialize(row.raw);
      const content = getMessageContent(msg);
      let type = extractMessageType(content);
      let body = extractText(content);
      if (type === "unknown") {
        const event = extractSystemEvent(msg);
        if (event) {
          type = "system";
          body = event;
        }
      }
      if (type !== "unknown") {
        update.run(type, row.body ?? body, row.id);
      }
    } catch {
      // Leave undecodable rows as unknown.
    }
  }
}

// Columns for enrichment output: a voice-note transcript and image OCR text.
function applyV4(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
  const has = (n: string) => cols.some((c) => c.name === n);
  if (!has("transcript")) db.exec("ALTER TABLE messages ADD COLUMN transcript TEXT");
  if (!has("ocr_text")) db.exec("ALTER TABLE messages ADD COLUMN ocr_text TEXT");
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
