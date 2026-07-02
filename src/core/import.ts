import { readFileSync } from "fs";
import {
  bulkUpsertMessages,
  bulkUpsertChats,
  getMessage,
  rebuildFtsIndex,
  type MessageRow,
  type ChatUpsert,
} from "./store.js";

export interface ImportResult {
  imported: number;
  skipped: number;
  invalid: number;
}

// Shape written by exportMessages() for format "jsonl" (src/core/export.ts).
// Lossy subset of MessageRow - no raw, no media crypto metadata, no location.
// See plans/notes/016-messages-import-design.md for the full rationale.
interface JsonlRow {
  id: string;
  chat_jid: string;
  sender_jid?: string | null;
  sender_name?: string | null;
  body?: string | null;
  type: string;
  timestamp: number;
  media_mime?: string | null;
  media_path?: string | null;
  quoted_id?: string | null;
  is_from_me?: number | boolean | null;
}

function isValidRow(value: unknown): value is JsonlRow {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" && r.id.length > 0 &&
    typeof r.chat_jid === "string" && r.chat_jid.length > 0 &&
    typeof r.type === "string" && r.type.length > 0 &&
    typeof r.timestamp === "number" && Number.isFinite(r.timestamp)
  );
}

// Fill every column the jsonl export doesn't carry with null - the importer
// never invents raw/media-crypto/location data it doesn't have.
function toMessageRow(row: JsonlRow): Omit<MessageRow, "created_at"> {
  return {
    id: row.id,
    chat_jid: row.chat_jid,
    sender_jid: row.sender_jid ?? null,
    sender_name: row.sender_name ?? null,
    body: row.body ?? null,
    type: row.type,
    media_mime: row.media_mime ?? null,
    media_path: row.media_path ?? null,
    media_size: null,
    media_direct_path: null,
    media_key: null,
    media_file_sha256: null,
    media_file_enc_sha256: null,
    media_file_length: null,
    quoted_id: row.quoted_id ?? null,
    location_lat: null,
    location_lon: null,
    location_name: null,
    is_from_me: row.is_from_me ? 1 : 0,
    timestamp: row.timestamp,
    raw: null,
  };
}

// Same heuristic the live listener uses (src/core/listener.ts) to label a
// freshly-seen chat when it first upserts a minimal chat row.
function chatTypeForJid(jid: string): string {
  return jid.endsWith("@g.us") ? "group" : "dm";
}

const BATCH_SIZE = 1000;

export function importMessagesJsonl(
  filePath: string,
  opts?: { mode?: "merge" | "skip" }
): ImportResult {
  const mode = opts?.mode ?? "merge";
  const lines = readFileSync(filePath, "utf-8").split("\n");

  const result: ImportResult = { imported: 0, skipped: 0, invalid: 0 };
  const chatLastMessageAt = new Map<string, number>();
  let batch: Omit<MessageRow, "created_at">[] = [];

  const flush = () => {
    if (batch.length === 0) return;
    bulkUpsertMessages(batch);
    result.imported += batch.length;
    batch = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      result.invalid++;
      continue;
    }

    if (!isValidRow(parsed)) {
      result.invalid++;
      continue;
    }

    if (mode === "skip" && getMessage(parsed.id)) {
      result.skipped++;
      continue;
    }

    const row = toMessageRow(parsed);
    batch.push(row);

    const currentMax = chatLastMessageAt.get(row.chat_jid) ?? 0;
    if (row.timestamp > currentMax) chatLastMessageAt.set(row.chat_jid, row.timestamp);

    if (batch.length >= BATCH_SIZE) flush();
  }
  flush();

  if (chatLastMessageAt.size > 0) {
    const chatRows: ChatUpsert[] = Array.from(chatLastMessageAt.entries()).map(
      ([jid, last_message_at]) => ({
        jid,
        name: null,
        type: chatTypeForJid(jid),
        participant_count: null,
        description: null,
        last_message_at,
      })
    );
    bulkUpsertChats(chatRows);
  }

  // Defensive, not required for correctness (FTS triggers keep the index in
  // sync per row) - a bulk import is the kind of write burst most likely to
  // surface latent index corruption, so self-heal once at the end.
  if (result.imported > 0) {
    rebuildFtsIndex();
  }

  return result;
}
