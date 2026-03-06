import { getDb } from "../db/database.js";
import type { MessageRow } from "./store.js";
import { writeFileSync, mkdirSync, statSync, openSync, writeSync, closeSync } from "fs";
import { dirname } from "path";

export interface ExportOptions {
  chatJid: string;
  after?: number;
  before?: number;
  format?: "jsonl" | "json" | "markdown" | "csv";
  output: string;
  excludeReactions?: boolean;
  batchSize?: number;
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
          if (row.body) {
            w(`### ${time} — ${sender}\n${row.body}\n\n`);
          } else if (row.media_mime) {
            w(`### ${time} — ${sender}\n(media: ${row.type}, mime: ${row.media_mime})\n\n`);
          } else {
            w(`### ${time} — ${sender}\n(${row.type})\n\n`);
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
