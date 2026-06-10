import { getDb } from "../db/database.js";
import type { MessageRow } from "./store.js";
import { deserializeWAMessage } from "./store.js";
import {
  getMessageContent,
  extractDocumentFileName,
  extractAudioMeta,
  extractAlbumLabel,
} from "./extract.js";
import type { WAMessage } from "@whiskeysockets/baileys";
import { writeFileSync, mkdirSync, statSync, existsSync, openSync, writeSync, closeSync } from "fs";
import { dirname, join, basename } from "path";

export interface ExportOptions {
  chatJid: string;
  after?: number;
  before?: number;
  format?: "jsonl" | "json" | "markdown" | "csv";
  output: string;
  excludeReactions?: boolean;
  types?: string[];
  excludeTypes?: string[];
  batchSize?: number;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Human-readable label for a non-text message, distinguishing media subtypes
// so a reader can tell a flyer image from a PDF from a voice note. Falls back
// to deserializing `raw` only for the types that carry extra detail.
export function mediaLabel(
  row: Pick<MessageRow, "type" | "media_mime" | "raw">
): string {
  switch (row.type) {
    case "image":
      return "[image]";
    case "video":
      return "[video]";
    case "sticker":
      return "[sticker]";
    case "poll":
      return "[poll]";
    case "contact":
      return "[contact]";
    case "location":
      return "[location]";
    case "deleted":
      return "[deleted]";
    case "reaction":
      return "[reaction]";
    case "edited":
      return "[edited]";
    case "system":
      return "[event]";
    case "album":
      return row.raw
        ? extractAlbumLabel(getMessageContent(deserializeWAMessage(row.raw) as WAMessage))
        : "[album]";
    case "audio": {
      const meta = row.raw
        ? extractAudioMeta(getMessageContent(deserializeWAMessage(row.raw) as WAMessage))
        : null;
      const dur = meta?.seconds ? ` ${formatDuration(meta.seconds)}` : "";
      return `[${meta?.ptt ? "voice" : "audio"}${dur}]`;
    }
    case "document": {
      const name = row.raw
        ? extractDocumentFileName(getMessageContent(deserializeWAMessage(row.raw) as WAMessage))
        : null;
      return name ? `[document: ${name}]` : "[document]";
    }
    default:
      return row.media_mime ? `[${row.type}: ${row.media_mime}]` : `[${row.type}]`;
  }
}

// One-line reference to a quoted message: "sender: first ~60 chars". Media
// without a caption falls back to its label so a reply to a flyer still reads.
export function quotedSnippet(
  q: Pick<MessageRow, "sender_name" | "sender_jid" | "type" | "media_mime" | "raw" | "body">
): string {
  const sender = q.sender_name || q.sender_jid || "unknown";
  const text = q.body ? q.body.replace(/\s+/g, " ").trim() : mediaLabel(q);
  const clipped = text.length > 60 ? `${text.slice(0, 60)}…` : text;
  return `${sender}: ${clipped}`;
}

export interface ExportResult {
  messages_exported: number;
  file: string;
  oldest: number | null;
  newest: number | null;
  file_size: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function escapeCSV(val: string | null): string {
  if (val === null || val === undefined) return "";
  const s = String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// --- Media manifest ---

// Media types the manifest links to as standalone files. Image and document
// carry readable content; stickers, reactions, audio and video are excluded.
export const MANIFEST_MEDIA_TYPES = ["image", "document"] as const;

export interface ManifestRow {
  msgId: string;
  type: string;
  sender: string | null;
  timestamp: number;
  caption: string | null;
  local_path: string | null;
  ocr_text: string | null;
  transcript: string | null;
}

function windowConditions(chatJid: string, after?: number, before?: number, types?: readonly string[]) {
  const conditions = ["chat_jid = ?", "media_mime IS NOT NULL"];
  const params: unknown[] = [chatJid];
  if (after) { conditions.push("timestamp > ?"); params.push(after); }
  if (before) { conditions.push("timestamp < ?"); params.push(before); }
  if (types?.length) {
    conditions.push(`type IN (${types.map(() => "?").join(", ")})`);
    params.push(...types);
  }
  return { where: conditions.join(" AND "), params };
}

// msgIds of manifest-eligible media in a window not yet downloaded.
export function collectUndownloadedMedia(
  chatJid: string,
  after?: number,
  before?: number,
  types: readonly string[] = MANIFEST_MEDIA_TYPES
): string[] {
  const db = getDb();
  const { where, params } = windowConditions(chatJid, after, before, types);
  const rows = db
    .prepare(`SELECT id FROM messages WHERE ${where} AND media_path IS NULL ORDER BY timestamp ASC`)
    .all(...params) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

// One manifest row per manifest-eligible media item in the window, with local_path
// resolved against the local media dir (handles the case where media_path was
// written by the remote daemon and only the basename matches locally).
export function buildManifest(
  chatJid: string,
  after: number | undefined,
  before: number | undefined,
  localMediaDir: string,
  types: readonly string[] = MANIFEST_MEDIA_TYPES
): ManifestRow[] {
  const db = getDb();
  const { where, params } = windowConditions(chatJid, after, before, types);
  const rows = db
    .prepare(
      `SELECT id, type, sender_name, sender_jid, body, timestamp, media_path, ocr_text, transcript FROM messages WHERE ${where} ORDER BY timestamp ASC`
    )
    .all(...params) as Array<
      Pick<MessageRow, "id" | "type" | "sender_name" | "sender_jid" | "body" | "timestamp" | "media_path"> &
        { ocr_text: string | null; transcript: string | null }
    >;

  return rows.map((r) => {
    let local: string | null = null;
    if (r.media_path) {
      const candidate = existsSync(r.media_path)
        ? r.media_path
        : join(localMediaDir, basename(r.media_path));
      local = existsSync(candidate) ? candidate : null;
    }
    return {
      msgId: r.id,
      type: r.type,
      sender: r.sender_name || r.sender_jid,
      timestamp: r.timestamp,
      caption: r.body,
      local_path: local,
      ocr_text: r.ocr_text,
      transcript: r.transcript,
    };
  });
}

// Media types worth pulling back as files for the manifest, plus audio when the
// caller also wants transcripts.
export const ENRICH_MANIFEST_MEDIA_TYPES = ["image", "document", "audio"] as const;

// msgIds in a window that still need enrichment: images without ocr_text (for
// ocr), audio without transcript (for transcribe). The column name is a fixed
// literal, never caller input.
export function collectEnrichTargets(
  chatJid: string,
  capability: "ocr" | "transcribe",
  after?: number,
  before?: number
): string[] {
  const type = capability === "ocr" ? "image" : "audio";
  const column = capability === "ocr" ? "ocr_text" : "transcript";
  const db = getDb();
  const { where, params } = windowConditions(chatJid, after, before, [type]);
  const rows = db
    .prepare(`SELECT id FROM messages WHERE ${where} AND ${column} IS NULL ORDER BY timestamp ASC`)
    .all(...params) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

export function writeManifest(path: string, rows: ManifestRow[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}

export function exportMessages(opts: ExportOptions): ExportResult {
  const db = getDb();
  const format = opts.format || "jsonl";
  const batchSize = opts.batchSize || 1000;

  // Ensure output directory exists
  mkdirSync(dirname(opts.output), { recursive: true });

  // Build query
  const conditions = ["chat_jid = ?"];
  const params: unknown[] = [opts.chatJid];

  if (opts.after) {
    conditions.push("timestamp > ?");
    params.push(opts.after);
  }
  if (opts.before) {
    conditions.push("timestamp < ?");
    params.push(opts.before);
  }
  if (opts.excludeReactions) {
    conditions.push("type != 'reaction'");
  }
  if (opts.types?.length) {
    conditions.push(`type IN (${opts.types.map(() => "?").join(", ")})`);
    params.push(...opts.types);
  }
  if (opts.excludeTypes?.length) {
    conditions.push(`type NOT IN (${opts.excludeTypes.map(() => "?").join(", ")})`);
    params.push(...opts.excludeTypes);
  }

  const where = conditions.join(" AND ");

  // Count total
  const countRow = db.prepare(`SELECT COUNT(*) as count FROM messages WHERE ${where}`).get(...params) as { count: number };
  const total = countRow.count;

  // Helper: synchronous write to fd
  const fd = openSync(opts.output, "w");
  const w = (s: string) => writeSync(fd, s);

  if (total === 0) {
    if (format === "json") w("[]");
    if (format === "csv") w("id,chat_jid,sender_jid,sender_name,body,type,timestamp\n");
    closeSync(fd);
    return { messages_exported: 0, file: opts.output, oldest: null, newest: null, file_size: "0B" };
  }

  // Write in batches using cursor-based pagination
  let exported = 0;
  let oldest: number | null = null;
  let newest: number | null = null;
  let lastTimestamp = 0;
  let lastRowid = 0;
  let isFirst = true;

  if (format === "json") w("[\n");
  if (format === "csv") w("id,chat_jid,sender_jid,sender_name,body,type,timestamp\n");
  if (format === "markdown") {
    w(`# Messages Export\n\n`);
  }

  // Use rowid-based cursor pagination for efficiency
  // First batch: no cursor
  const firstBatchStmt = db.prepare(
    `SELECT *, rowid FROM messages WHERE ${where} ORDER BY timestamp ASC, rowid ASC LIMIT ?`
  );
  // Subsequent batches: cursor from last row
  const nextBatchStmt = db.prepare(
    `SELECT *, rowid FROM messages WHERE ${where} AND (timestamp > ? OR (timestamp = ? AND rowid > ?)) ORDER BY timestamp ASC, rowid ASC LIMIT ?`
  );

  let currentDay = "";
  const quotedStmt = db.prepare(
    "SELECT sender_name, sender_jid, type, media_mime, raw, body FROM messages WHERE id = ?"
  );
  let batch: (MessageRow & { rowid: number })[];

  // First batch
  batch = firstBatchStmt.all(...params, batchSize) as (MessageRow & { rowid: number })[];

  while (batch.length > 0) {
    for (const row of batch) {
      if (oldest === null || row.timestamp < oldest) oldest = row.timestamp;
      if (newest === null || row.timestamp > newest) newest = row.timestamp;

      switch (format) {
        case "jsonl":
          w(JSON.stringify({
            id: row.id,
            chat_jid: row.chat_jid,
            sender_jid: row.sender_jid,
            sender_name: row.sender_name,
            body: row.body,
            type: row.type,
            timestamp: row.timestamp,
            media_mime: row.media_mime,
            media_path: row.media_path,
            quoted_id: row.quoted_id,
            is_from_me: row.is_from_me,
          }) + "\n");
          break;

        case "json":
          if (!isFirst) w(",\n");
          w(JSON.stringify({
            id: row.id,
            chat_jid: row.chat_jid,
            sender_jid: row.sender_jid,
            sender_name: row.sender_name,
            body: row.body,
            type: row.type,
            timestamp: row.timestamp,
            media_mime: row.media_mime,
            media_path: row.media_path,
            quoted_id: row.quoted_id,
            is_from_me: row.is_from_me,
          }, null, 2));
          break;

        case "markdown": {
          const date = new Date(row.timestamp * 1000);
          const dayStr = date.toISOString().split("T")[0];
          if (dayStr !== currentDay) {
            currentDay = dayStr;
            w(`\n## ${dayStr}\n\n`);
          }
          const time = date.toTimeString().slice(0, 5);
          const sender = row.sender_name || row.sender_jid || (row.is_from_me ? "Me" : "Unknown");
          // Replies reference what they answer; one indexed lookup per reply row.
          let reply = "";
          if (row.quoted_id) {
            const q = quotedStmt.get(row.quoted_id) as
              | Pick<MessageRow, "sender_name" | "sender_jid" | "type" | "media_mime" | "raw" | "body">
              | undefined;
            if (q) reply = `↩ to ${quotedSnippet(q)}\n`;
          }
          if (row.type === "text") {
            w(`### ${time} — ${sender}\n${reply}${row.body || ""}\n\n`);
          } else {
            // Media/other: distinct label, with caption appended when present
            const caption = row.body ? ` ${row.body}` : "";
            w(`### ${time} — ${sender}\n${reply}${mediaLabel(row)}${caption}\n\n`);
          }
          break;
        }

        case "csv":
          w([
            escapeCSV(row.id),
            escapeCSV(row.chat_jid),
            escapeCSV(row.sender_jid),
            escapeCSV(row.sender_name),
            escapeCSV(row.body),
            escapeCSV(row.type),
            String(row.timestamp),
          ].join(",") + "\n");
          break;
      }

      isFirst = false;
      lastTimestamp = row.timestamp;
      lastRowid = row.rowid;
      exported++;
    }

    // Next batch using cursor
    batch = nextBatchStmt.all(...params, lastTimestamp, lastTimestamp, lastRowid, batchSize) as (MessageRow & { rowid: number })[];
  }

  if (format === "json") w("\n]");
  closeSync(fd);

  // Get file size
  const stat = statSync(opts.output);

  return {
    messages_exported: exported,
    file: opts.output,
    oldest,
    newest,
    file_size: formatBytes(stat.size),
  };
}
