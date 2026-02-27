import type Database from "better-sqlite3";
import { getDb } from "../db/database.js";

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
  quoted_id: string | null;
  location_lat: number | null;
  location_lon: number | null;
  location_name: string | null;
  is_from_me: number;
  timestamp: number;
  raw: string | null;
  created_at: number;
}

export interface ChatRow {
  jid: string;
  name: string | null;
  type: string;
  participant_count: number | null;
  description: string | null;
  last_message_at: number | null;
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

// --- Single-row upserts ---

export function upsertMessage(row: Omit<MessageRow, "created_at">): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO messages (id, chat_jid, sender_jid, sender_name, body, type, media_mime, media_path, media_size, quoted_id, location_lat, location_lon, location_name, is_from_me, timestamp, raw)
    VALUES (@id, @chat_jid, @sender_jid, @sender_name, @body, @type, @media_mime, @media_path, @media_size, @quoted_id, @location_lat, @location_lon, @location_name, @is_from_me, @timestamp, @raw)
    ON CONFLICT(id) DO UPDATE SET
      body = COALESCE(excluded.body, messages.body),
      sender_name = COALESCE(excluded.sender_name, messages.sender_name),
      media_path = COALESCE(excluded.media_path, messages.media_path),
      raw = COALESCE(excluded.raw, messages.raw)
  `).run(row);
}

export function upsertChat(row: Omit<ChatRow, "updated_at">): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO chats (jid, name, type, participant_count, description, last_message_at)
    VALUES (@jid, @name, @type, @participant_count, @description, @last_message_at)
    ON CONFLICT(jid) DO UPDATE SET
      name = COALESCE(excluded.name, chats.name),
      participant_count = COALESCE(excluded.participant_count, chats.participant_count),
      description = COALESCE(excluded.description, chats.description),
      last_message_at = MAX(COALESCE(excluded.last_message_at, 0), COALESCE(chats.last_message_at, 0)),
      updated_at = unixepoch()
  `).run(row);
}

export function upsertContact(row: Omit<ContactRow, "updated_at">): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO contacts (jid, phone, push_name, saved_name, is_business)
    VALUES (@jid, @phone, @push_name, @saved_name, @is_business)
    ON CONFLICT(jid) DO UPDATE SET
      phone = COALESCE(excluded.phone, contacts.phone),
      push_name = COALESCE(excluded.push_name, contacts.push_name),
      saved_name = COALESCE(excluded.saved_name, contacts.saved_name),
      is_business = COALESCE(excluded.is_business, contacts.is_business),
      updated_at = unixepoch()
  `).run(row);
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
  const stmt = db.prepare(`
    INSERT INTO messages (id, chat_jid, sender_jid, sender_name, body, type, media_mime, media_path, media_size, quoted_id, location_lat, location_lon, location_name, is_from_me, timestamp, raw)
    VALUES (@id, @chat_jid, @sender_jid, @sender_name, @body, @type, @media_mime, @media_path, @media_size, @quoted_id, @location_lat, @location_lon, @location_name, @is_from_me, @timestamp, @raw)
    ON CONFLICT(id) DO UPDATE SET
      body = COALESCE(excluded.body, messages.body),
      sender_name = COALESCE(excluded.sender_name, messages.sender_name),
      media_path = COALESCE(excluded.media_path, messages.media_path),
      raw = COALESCE(excluded.raw, messages.raw)
  `);
  db.transaction(() => {
    for (const row of rows) {
      stmt.run(row);
    }
  })();
}

export function bulkUpsertChats(rows: Omit<ChatRow, "updated_at">[]): void {
  if (rows.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO chats (jid, name, type, participant_count, description, last_message_at)
    VALUES (@jid, @name, @type, @participant_count, @description, @last_message_at)
    ON CONFLICT(jid) DO UPDATE SET
      name = COALESCE(excluded.name, chats.name),
      participant_count = COALESCE(excluded.participant_count, chats.participant_count),
      description = COALESCE(excluded.description, chats.description),
      last_message_at = MAX(COALESCE(excluded.last_message_at, 0), COALESCE(chats.last_message_at, 0)),
      updated_at = unixepoch()
  `);
  db.transaction(() => {
    for (const row of rows) {
      stmt.run(row);
    }
  })();
}

export function bulkUpsertContacts(rows: Omit<ContactRow, "updated_at">[]): void {
  if (rows.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO contacts (jid, phone, push_name, saved_name, is_business)
    VALUES (@jid, @phone, @push_name, @saved_name, @is_business)
    ON CONFLICT(jid) DO UPDATE SET
      phone = COALESCE(excluded.phone, contacts.phone),
      push_name = COALESCE(excluded.push_name, contacts.push_name),
      saved_name = COALESCE(excluded.saved_name, contacts.saved_name),
      is_business = COALESCE(excluded.is_business, contacts.is_business),
      updated_at = unixepoch()
  `);
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

export function searchMessages(
  query: string,
  opts?: { chatJid?: string; senderJid?: string; limit?: number }
): MessageRow[] {
  const db = getDb();
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
  params.push(opts?.limit || 50);
  return db
    .prepare(
      `SELECT * FROM messages WHERE ${conditions.join(" AND ")} ORDER BY timestamp DESC LIMIT ?`
    )
    .all(...params) as MessageRow[];
}

export function getMessage(id: string): MessageRow | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as
    | MessageRow
    | undefined;
}

export function listChats(opts?: { limit?: number }): ChatRow[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM chats ORDER BY last_message_at DESC NULLS LAST LIMIT ?"
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
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as count FROM messages").get() as {
    count: number;
  };
  return row.count;
}

// --- Delete operations ---

export function deleteMessage(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM messages WHERE id = ?").run(id);
}

export function markMessageDeleted(id: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE messages SET body = NULL, type = 'deleted', raw = NULL WHERE id = ?"
  ).run(id);
}
