import type Database from "better-sqlite3";
import { getDb, prepareCached } from "../db/database.js";

// --- Type definitions ---

export interface MessageRow {
  id: string;
  chat_jid: string;
  sender_jid: string | null;
  sender_name: string | null;
  body: string | null;
  type: string;
  media_mime: string | null;
  media_path: string | null;
  media_size: number | null;
  media_direct_path: string | null;
  media_key: string | null;
  media_file_sha256: string | null;
  media_file_enc_sha256: string | null;
  media_file_length: number | null;
  quoted_id: string | null;
  location_lat: number | null;
  location_lon: number | null;
  location_name: string | null;
  is_from_me: number;
  timestamp: number;
  raw: string | null;
  created_at: number;
}

export interface SearchResult extends MessageRow {
  snippet: string | null;
  rank: number;
}

export interface ChatRow {
  jid: string;
  name: string | null;
  type: string;
  participant_count: number | null;
  description: string | null;
  last_message_at: number | null;
  last_seen_at: number | null;
  is_community: number;
  is_community_announce: number;
  linked_parent: string | null;
  updated_at: number;
}

export interface ContactRow {
  jid: string;
  phone: string | null;
  push_name: string | null;
  saved_name: string | null;
  is_business: number;
  updated_at: number;
}

export interface GroupParticipantRow {
  group_jid: string;
  participant_jid: string;
  is_admin: number;
  is_super_admin: number;
}

// --- Raw WAMessage serialization ---

function isUint8Array(val: unknown): val is Uint8Array {
  return val instanceof Uint8Array;
}

export function serializeWAMessage(msg: unknown): string {
  return JSON.stringify(msg, (_key, value) => {
    if (isUint8Array(value)) {
      return { __type: "Uint8Array", data: Buffer.from(value).toString("base64") };
    }
    return value;
  });
}

export function deserializeWAMessage(raw: string): unknown {
  return JSON.parse(raw, (_key, value) => {
    if (
      value &&
      typeof value === "object" &&
      value.__type === "Uint8Array" &&
      typeof value.data === "string"
    ) {
      return new Uint8Array(Buffer.from(value.data, "base64"));
    }
    return value;
  });
}

// --- FTS write-path resilience ---
//
// Message writes pass through the messages_fts AFTER INSERT trigger. A corrupt
// FTS index ("database disk image is malformed") makes that trigger throw,
// which aborts the whole INSERT. In the daemon those throws are swallowed by
// the event-handler guard, so a one-off corruption silently stops ingestion
// for good while the socket stays healthy. Recover in place: rebuild the index
// from the content table once and retry, so a transient corruption self-heals
// instead of stalling writes forever. The read path already degrades to LIKE;
// this gives the write path the same tolerance.

let _ftsRebuilds = 0;
let _lastStoreErrorAt: number | null = null;
let _lastStoreError: string | null = null;

export interface StoreHealth {
  fts_rebuilds: number;
  last_store_error_at: number | null;
  last_store_error: string | null;
}

export function getStoreHealth(): StoreHealth {
  return {
    fts_rebuilds: _ftsRebuilds,
    last_store_error_at: _lastStoreErrorAt,
    last_store_error: _lastStoreError,
  };
}

export function rebuildFtsIndex(): void {
  getDb().exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  _ftsAvailable = undefined; // force a re-probe on next read
}

function isMalformedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /malformed|disk image|SQLITE_CORRUPT/i.test(msg);
}

// Exported for tests. Production callers use it implicitly via the message
// upserts; the recovery is the same regardless of caller.
export function withFtsRecovery<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (!isMalformedError(err)) throw err;
    try {
      rebuildFtsIndex();
      _ftsRebuilds++;
    } catch (rebuildErr) {
      _lastStoreErrorAt = Math.floor(Date.now() / 1000);
      _lastStoreError = `fts rebuild failed: ${(rebuildErr as Error).message}`;
      throw err;
    }
    try {
      return fn();
    } catch (retryErr) {
      _lastStoreErrorAt = Math.floor(Date.now() / 1000);
      _lastStoreError = (retryErr as Error).message;
      throw retryErr;
    }
  }
}

// --- Single-row upserts ---

const MESSAGE_UPSERT_SQL = `
  INSERT INTO messages (id, chat_jid, sender_jid, sender_name, body, type, media_mime, media_path, media_size, media_direct_path, media_key, media_file_sha256, media_file_enc_sha256, media_file_length, quoted_id, location_lat, location_lon, location_name, is_from_me, timestamp, raw)
  VALUES (@id, @chat_jid, @sender_jid, @sender_name, @body, @type, @media_mime, @media_path, @media_size, @media_direct_path, @media_key, @media_file_sha256, @media_file_enc_sha256, @media_file_length, @quoted_id, @location_lat, @location_lon, @location_name, @is_from_me, @timestamp, @raw)
  ON CONFLICT(id) DO UPDATE SET
    body = COALESCE(excluded.body, messages.body),
    sender_name = COALESCE(excluded.sender_name, messages.sender_name),
    media_path = COALESCE(excluded.media_path, messages.media_path),
    media_direct_path = COALESCE(excluded.media_direct_path, messages.media_direct_path),
    media_key = COALESCE(excluded.media_key, messages.media_key),
    media_file_sha256 = COALESCE(excluded.media_file_sha256, messages.media_file_sha256),
    media_file_enc_sha256 = COALESCE(excluded.media_file_enc_sha256, messages.media_file_enc_sha256),
    media_file_length = COALESCE(excluded.media_file_length, messages.media_file_length),
    raw = COALESCE(excluded.raw, messages.raw)
`;

export function upsertMessage(row: Omit<MessageRow, "created_at">): void {
  const stmt = prepareCached(MESSAGE_UPSERT_SQL);
  withFtsRecovery(() => stmt.run(row));
}

export type ChatUpsert = Omit<
  ChatRow,
  "updated_at" | "last_seen_at" | "is_community" | "is_community_announce" | "linked_parent"
> & {
  last_seen_at?: number | null;
  is_community?: number | null;
  is_community_announce?: number | null;
  linked_parent?: string | null;
};

const CHAT_UPSERT_SQL = `
  INSERT INTO chats (jid, name, type, participant_count, description, last_message_at, last_seen_at, is_community, is_community_announce, linked_parent)
  VALUES (@jid, @name, @type, @participant_count, @description, @last_message_at, @last_seen_at, @is_community, @is_community_announce, @linked_parent)
  ON CONFLICT(jid) DO UPDATE SET
    name = COALESCE(excluded.name, chats.name),
    participant_count = COALESCE(excluded.participant_count, chats.participant_count),
    description = COALESCE(excluded.description, chats.description),
    last_message_at = MAX(COALESCE(excluded.last_message_at, 0), COALESCE(chats.last_message_at, 0)),
    last_seen_at = MAX(COALESCE(excluded.last_seen_at, 0), COALESCE(chats.last_seen_at, 0)),
    is_community = COALESCE(excluded.is_community, chats.is_community),
    is_community_announce = COALESCE(excluded.is_community_announce, chats.is_community_announce),
    linked_parent = COALESCE(excluded.linked_parent, chats.linked_parent),
    updated_at = unixepoch()
`;

export function upsertChat(row: ChatUpsert): void {
  const params = {
    last_seen_at: null,
    is_community: null,
    is_community_announce: null,
    linked_parent: null,
    ...row,
  };
  prepareCached(CHAT_UPSERT_SQL).run(params);
}

const CONTACT_UPSERT_SQL = `
  INSERT INTO contacts (jid, phone, push_name, saved_name, is_business)
  VALUES (@jid, @phone, @push_name, @saved_name, @is_business)
  ON CONFLICT(jid) DO UPDATE SET
    phone = COALESCE(excluded.phone, contacts.phone),
    push_name = COALESCE(excluded.push_name, contacts.push_name),
    saved_name = COALESCE(excluded.saved_name, contacts.saved_name),
    is_business = COALESCE(excluded.is_business, contacts.is_business),
    updated_at = unixepoch()
`;

export function upsertContact(row: Omit<ContactRow, "updated_at">): void {
  prepareCached(CONTACT_UPSERT_SQL).run(row);
}

export function upsertGroupParticipants(
  groupJid: string,
  participants: Array<{ jid: string; isAdmin: boolean; isSuperAdmin: boolean }>
): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM group_participants WHERE group_jid = ?").run(groupJid);
    const insert = db.prepare(`
      INSERT INTO group_participants (group_jid, participant_jid, is_admin, is_super_admin)
      VALUES (?, ?, ?, ?)
    `);
    for (const p of participants) {
      insert.run(groupJid, p.jid, p.isAdmin ? 1 : 0, p.isSuperAdmin ? 1 : 0);
    }
  });
  tx();
}

// --- Bulk upserts (transaction-wrapped) ---

export function bulkUpsertMessages(rows: Omit<MessageRow, "created_at">[]): void {
  if (rows.length === 0) return;
  const db = getDb();
  const stmt = prepareCached(MESSAGE_UPSERT_SQL);
  const tx = db.transaction(() => {
    for (const row of rows) {
      stmt.run(row);
    }
  });
  withFtsRecovery(() => tx());
}

export function bulkUpsertChats(rows: ChatUpsert[]): void {
  if (rows.length === 0) return;
  const db = getDb();
  const stmt = prepareCached(CHAT_UPSERT_SQL);
  db.transaction(() => {
    for (const row of rows) {
      stmt.run({
        last_seen_at: null,
        is_community: null,
        is_community_announce: null,
        linked_parent: null,
        ...row,
      });
    }
  })();
}

export function bulkUpsertContacts(rows: Omit<ContactRow, "updated_at">[]): void {
  if (rows.length === 0) return;
  const db = getDb();
  const stmt = prepareCached(CONTACT_UPSERT_SQL);
  db.transaction(() => {
    for (const row of rows) {
      stmt.run(row);
    }
  })();
}

// --- Read operations ---

export interface ListMessagesOpts {
  chatJid: string;
  limit?: number;
  before?: number;
  after?: number;
}

export function listMessages(opts: ListMessagesOpts): MessageRow[] {
  const db = getDb();
  const conditions = ["chat_jid = ?"];
  const params: unknown[] = [opts.chatJid];
  if (opts.before) {
    conditions.push("timestamp < ?");
    params.push(opts.before);
  }
  if (opts.after) {
    conditions.push("timestamp > ?");
    params.push(opts.after);
  }
  params.push(opts.limit || 50);
  return db
    .prepare(
      `SELECT * FROM messages WHERE ${conditions.join(" AND ")} ORDER BY timestamp DESC LIMIT ?`
    )
    .all(...params) as MessageRow[];
}

function toFtsQuery(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}

let _ftsAvailable: boolean | undefined;

function canUseFts(db: Database.Database): boolean {
  if (_ftsAvailable !== undefined) return _ftsAvailable;
  try {
    db.prepare("SELECT 1 FROM messages_fts LIMIT 0").run();
    _ftsAvailable = true;
  } catch {
    _ftsAvailable = false;
  }
  return _ftsAvailable;
}

export function searchMessages(
  query: string,
  opts?: { chatJid?: string; senderJid?: string; limit?: number; after?: number; before?: number }
): SearchResult[] {
  const db = getDb();
  const limit = opts?.limit || 50;

  if (canUseFts(db)) {
    const ftsQuery = toFtsQuery(query);
    const conditions = ["messages_fts MATCH ?"];
    const params: unknown[] = [ftsQuery];

    let chatFilter = "";
    if (opts?.chatJid) {
      chatFilter += " AND m.chat_jid = ?";
      params.push(opts.chatJid);
    }
    if (opts?.senderJid) {
      chatFilter += " AND m.sender_jid = ?";
      params.push(opts.senderJid);
    }
    if (opts?.after) {
      chatFilter += " AND m.timestamp > ?";
      params.push(opts.after);
    }
    if (opts?.before) {
      chatFilter += " AND m.timestamp < ?";
      params.push(opts.before);
    }
    params.push(limit);

    try {
      return db
        .prepare(
          `SELECT m.*, snippet(messages_fts, -1, '>>>', '<<<', '...', 40) AS snippet, rank
           FROM messages_fts
           JOIN messages m ON m.rowid = messages_fts.rowid
           WHERE ${conditions.join(" AND ")}${chatFilter}
           ORDER BY rank
           LIMIT ?`
        )
        .all(...params) as SearchResult[];
    } catch {
      // A corrupt FTS index throws "database disk image is malformed" on the
      // ranked read; fall back to a LIKE scan so search still returns results.
      // `wu db reindex` rebuilds the index to restore ranked search.
    }
  }

  // Fallback: LIKE search (pre-FTS DBs, or a corrupt FTS index)
  const conditions = ["body LIKE ?"];
  const params: unknown[] = [`%${query}%`];
  if (opts?.chatJid) {
    conditions.push("chat_jid = ?");
    params.push(opts.chatJid);
  }
  if (opts?.senderJid) {
    conditions.push("sender_jid = ?");
    params.push(opts.senderJid);
  }
  if (opts?.after) {
    conditions.push("timestamp > ?");
    params.push(opts.after);
  }
  if (opts?.before) {
    conditions.push("timestamp < ?");
    params.push(opts.before);
  }
  params.push(limit);
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE ${conditions.join(" AND ")} ORDER BY timestamp DESC LIMIT ?`
    )
    .all(...params) as MessageRow[];

  return rows.map((r) => ({ ...r, snippet: null, rank: 0 }));
}

export function getMessage(id: string): MessageRow | undefined {
  return prepareCached("SELECT * FROM messages WHERE id = ?").get(id) as
    | MessageRow
    | undefined;
}

export function getMessagesByIds(ids: string[]): Map<string, MessageRow> {
  const out = new Map<string, MessageRow>();
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (unique.length === 0) return out;
  const db = getDb();
  // SQLite has a variable limit (default 999); chunk to stay well under it.
  const CHUNK = 500;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare(`SELECT * FROM messages WHERE id IN (${placeholders})`)
      .all(...chunk) as MessageRow[];
    for (const r of rows) out.set(r.id, r);
  }
  return out;
}

export function listChats(opts?: { limit?: number }): ChatRow[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM chats ORDER BY last_message_at DESC NULLS LAST LIMIT ?"
    )
    .all(opts?.limit || 100) as ChatRow[];
}

export function listGroups(opts?: { limit?: number }): ChatRow[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM chats WHERE type = 'group' ORDER BY is_community DESC, COALESCE(name, jid) ASC LIMIT ?"
    )
    .all(opts?.limit || 1000) as ChatRow[];
}

export function listCommunities(opts?: { limit?: number }): ChatRow[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM chats WHERE type = 'group' AND is_community = 1 ORDER BY COALESCE(name, jid) ASC LIMIT ?"
    )
    .all(opts?.limit || 100) as ChatRow[];
}

export function listDms(opts?: { limit?: number }): ChatRow[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM chats WHERE type = 'dm' ORDER BY last_message_at DESC NULLS LAST LIMIT ?"
    )
    .all(opts?.limit || 100) as ChatRow[];
}

export function searchChats(query: string, opts?: { limit?: number }): ChatRow[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM chats WHERE name LIKE ? ORDER BY last_message_at DESC NULLS LAST LIMIT ?"
    )
    .all(`%${query}%`, opts?.limit || 100) as ChatRow[];
}

export function listContacts(opts?: { limit?: number }): ContactRow[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM contacts ORDER BY push_name ASC NULLS LAST LIMIT ?")
    .all(opts?.limit || 100) as ContactRow[];
}

export function searchContacts(
  query: string,
  opts?: { limit?: number }
): ContactRow[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM contacts WHERE push_name LIKE ? OR saved_name LIKE ? OR phone LIKE ? ORDER BY push_name ASC NULLS LAST LIMIT ?"
    )
    .all(`%${query}%`, `%${query}%`, `%${query}%`, opts?.limit || 100) as ContactRow[];
}

export function getGroupParticipants(
  groupJid: string
): GroupParticipantRow[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM group_participants WHERE group_jid = ?")
    .all(groupJid) as GroupParticipantRow[];
}

export function getMessageCount(): number {
  const row = prepareCached("SELECT COUNT(*) as count FROM messages").get() as {
    count: number;
  };
  return row.count;
}

export function getFilteredMessageCount(opts?: {
  chatJid?: string;
  after?: number;
  before?: number;
}): number {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (opts?.chatJid) {
    conditions.push("chat_jid = ?");
    params.push(opts.chatJid);
  }
  if (opts?.after) {
    conditions.push("timestamp > ?");
    params.push(opts.after);
  }
  if (opts?.before) {
    conditions.push("timestamp < ?");
    params.push(opts.before);
  }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  const row = db.prepare(`SELECT COUNT(*) as count FROM messages${where}`).get(...params) as { count: number };
  return row.count;
}

// --- Context window ---

export function getMessageContext(
  id: string,
  opts?: { beforeCount?: number; afterCount?: number }
): { target: MessageRow; before: MessageRow[]; after: MessageRow[] } | null {
  const db = getDb();
  const target = db
    .prepare("SELECT *, rowid FROM messages WHERE id = ?")
    .get(id) as (MessageRow & { rowid: number }) | undefined;

  if (!target) return null;

  const beforeCount = opts?.beforeCount ?? 10;
  const afterCount = opts?.afterCount ?? 10;

  const before = db
    .prepare(
      `SELECT * FROM messages
       WHERE chat_jid = ? AND (timestamp < ? OR (timestamp = ? AND rowid < ?))
       ORDER BY timestamp DESC, rowid DESC
       LIMIT ?`
    )
    .all(target.chat_jid, target.timestamp, target.timestamp, target.rowid, beforeCount) as MessageRow[];
  before.reverse();

  const after = db
    .prepare(
      `SELECT * FROM messages
       WHERE chat_jid = ? AND (timestamp > ? OR (timestamp = ? AND rowid > ?))
       ORDER BY timestamp ASC, rowid ASC
       LIMIT ?`
    )
    .all(target.chat_jid, target.timestamp, target.timestamp, target.rowid, afterCount) as MessageRow[];

  return { target, before, after };
}

// --- Delete operations ---

export function deleteMessage(id: string): void {
  const db = getDb();
  withFtsRecovery(() => db.prepare("DELETE FROM messages WHERE id = ?").run(id));
}

export function markMessageDeleted(id: string): void {
  const db = getDb();
  withFtsRecovery(() =>
    db.prepare(
      "UPDATE messages SET body = NULL, type = 'deleted', raw = NULL WHERE id = ?"
    ).run(id)
  );
}
