import {
  downloadMediaMessage,
  downloadContentFromMessage,
  type WASocket,
  type WAMessage,
  type MediaType,
} from "@whiskeysockets/baileys";
import { writeFileSync, mkdirSync, statSync, unlinkSync, existsSync, readdirSync } from "fs";
import { join, extname, basename, resolve, sep } from "path";
import type { WuConfig } from "../config/schema.js";
import { getMessage, upsertMessage, deserializeWAMessage, withFtsRecovery, type MessageRow } from "./store.js";
import { enrichFile, type Capability } from "./enrich.js";
import { MEDIA_DIR } from "../config/paths.js";
import { createChildLogger } from "../config/logger.js";
import { asyncPool } from "./pool.js";
import { getDb } from "../db/database.js";

const logger = createChildLogger("media");

// msg.key.id is remote-controlled (it comes straight off the wire) and is used
// verbatim to name the downloaded file, so it has to be restricted to a safe
// filename charset before it ever reaches a fs call.
export function assertSafeMsgId(msgId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(msgId)) {
    throw new Error(`Unsafe message id for file write: ${JSON.stringify(msgId)}`);
  }
}

// Belt-and-suspenders check that the final write target actually lands inside
// the directory it was supposed to, regardless of how dir/msgId were derived.
export function assertWithin(parentDir: string, childPath: string): void {
  const parent = resolve(parentDir);
  const child = resolve(childPath);
  if (child !== parent && !child.startsWith(parent + sep)) {
    throw new Error(`Refusing to write outside media directory: ${child}`);
  }
}

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "audio/ogg; codecs=opus": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "application/pdf": ".pdf",
};

function getMediaType(row: MessageRow): MediaType {
  if (row.type === "sticker") return "sticker";
  const prefix = row.media_mime?.split("/")[0];
  if (prefix === "image") return "image";
  if (prefix === "video") return "video";
  if (prefix === "audio") return "audio";
  return "document";
}

async function downloadFromStoredMetadata(row: MessageRow): Promise<Buffer> {
  if (!row.media_direct_path || !row.media_key) {
    throw new Error("No stored media metadata for re-download");
  }

  const mediaType = getMediaType(row);
  const stream = await downloadContentFromMessage(
    {
      mediaKey: Buffer.from(row.media_key, "base64"),
      directPath: row.media_direct_path,
      url: undefined,
    },
    mediaType,
  );

  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function downloadMedia(
  msgId: string,
  sock: WASocket,
  config: WuConfig,
  outDir?: string
): Promise<{ path: string; mime: string; size: number }> {
  const row = getMessage(msgId);
  if (!row) {
    throw new Error(`Message not found: ${msgId}`);
  }

  // Check media size limit
  const maxBytes = (config.whatsapp.media_max_mb || 50) * 1024 * 1024;
  if (row.media_size && row.media_size > maxBytes) {
    throw new Error(
      `Media exceeds size limit (${(row.media_size / 1048576).toFixed(1)}MB > ${config.whatsapp.media_max_mb}MB)`
    );
  }

  let buffer: Buffer;

  if (row.raw) {
    const msg = deserializeWAMessage(row.raw) as WAMessage;
    try {
      buffer = (await downloadMediaMessage(msg, "buffer", {}, {
        reuploadRequest: (m) => sock.updateMediaMessage(m),
        logger: logger as any,
      })) as Buffer;
    } catch (err: unknown) {
      const statusCode = (err as any)?.output?.statusCode || (err as any)?.statusCode;
      if (statusCode === 410 || statusCode === 404) {
        // Try stored metadata fallback
        if (row.media_direct_path && row.media_key) {
          logger.warn({ msgId }, "Media expired, using stored metadata");
          buffer = await downloadFromStoredMetadata(row);
        } else {
          logger.warn({ msgId }, "Media expired, requesting re-upload");
          const updated = await sock.updateMediaMessage(msg);
          buffer = (await downloadMediaMessage(updated, "buffer", {}, {
            logger: logger as any,
          } as any)) as Buffer;
        }
      } else {
        throw err;
      }
    }
  } else if (row.media_direct_path && row.media_key) {
    // No raw message but have stored metadata
    buffer = await downloadFromStoredMetadata(row);
  } else {
    throw new Error(`No raw data or media metadata for message: ${msgId}`);
  }

  const mime = row.media_mime || "application/octet-stream";
  const ext = MIME_TO_EXT[mime] || extname(row.media_path || "") || ".bin";
  const dir = outDir || config.whatsapp.media_dir || MEDIA_DIR;
  assertSafeMsgId(msgId);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${msgId}${ext}`);
  assertWithin(dir, filePath);
  writeFileSync(filePath, buffer);

  // Update media_path in DB
  const db = getDb();
  db.prepare("UPDATE messages SET media_path = ? WHERE id = ?").run(filePath, msgId);

  logger.debug({ msgId, path: filePath, size: buffer.length }, "Media downloaded");

  return { path: filePath, mime, size: buffer.length };
}

export interface BatchDownloadResult {
  msgId: string;
  path: string;
  mime: string;
  size: number;
}

export async function downloadMediaBatch(
  msgIds: string[],
  sock: WASocket,
  config: WuConfig,
  outDir?: string,
  opts?: { concurrency?: number; onProgress?: (completed: number, total: number) => void }
): Promise<{ results: BatchDownloadResult[]; errors: Array<{ msgId: string; error: string }> }> {
  const concurrency = opts?.concurrency ?? 4;
  const results: BatchDownloadResult[] = [];
  const errors: Array<{ msgId: string; error: string }> = [];

  const poolResults = await asyncPool(
    msgIds,
    concurrency,
    async (msgId) => {
      const result = await downloadMedia(msgId, sock, config, outDir);
      return { msgId, ...result };
    },
    (completed, total) => {
      opts?.onProgress?.(completed, total);
    },
  );

  for (const pr of poolResults) {
    if (pr.status === "fulfilled") {
      results.push(pr.value);
    } else {
      errors.push({ msgId: pr.item, error: pr.reason });
    }
  }

  return { results, errors };
}

// Parse a duration like "30d", "12h", "2w", "45m" into seconds. Bare numbers
// are treated as days. Returns null on garbage.
export function parseDuration(input: string): number | null {
  const m = /^(\d+)\s*([smhdw]?)$/i.exec(input.trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = (m[2] || "d").toLowerCase();
  const mult: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  return n * (mult[unit] ?? 86400);
}

// Resolve a message's downloaded media to a path that exists on this machine.
// Handles media_path written by a remote daemon (only the basename matches the
// local media dir after rsync) and the case where the local row has no
// media_path yet but the file was rsynced in named by message id.
export function resolveLocalMediaPath(row: Pick<MessageRow, "id" | "media_path">): string | null {
  if (row.media_path) {
    if (existsSync(row.media_path)) return row.media_path;
    const byBasename = join(MEDIA_DIR, basename(row.media_path));
    if (existsSync(byBasename)) return byBasename;
  }
  // Downloads are written as <msgId><ext>; find it in the media dir by id.
  try {
    const match = readdirSync(MEDIA_DIR).find((f) => f.startsWith(`${row.id}.`));
    if (match) return join(MEDIA_DIR, match);
  } catch { /* media dir may not exist */ }
  return null;
}

export interface EnrichMessageResult {
  msgId: string;
  capability: Capability;
  backend: string;
  chars: number;
}

// Extract text from a message's media and persist it. Transcripts and OCR text
// land in their own columns; for searchability the text is also folded into
// `body` when the message has none (voice notes), which the FTS triggers index.
export async function enrichMessage(
  capability: Capability,
  msgId: string,
  config: WuConfig
): Promise<EnrichMessageResult> {
  const row = getMessage(msgId);
  if (!row) throw new Error(`Message not found: ${msgId}`);

  const wantType = capability === "transcribe" ? "audio" : "image";
  if (row.type !== wantType) {
    throw new Error(`Message ${msgId} is type '${row.type}', expected '${wantType}'`);
  }

  const file = resolveLocalMediaPath(row);
  if (!file) {
    throw new Error(`Media for ${msgId} is not downloaded locally — download it first`);
  }

  const text = await enrichFile(capability, file, config.enrich);
  const column = capability === "transcribe" ? "transcript" : "ocr_text";
  const db = getDb();
  if (row.body) {
    withFtsRecovery(() => db.prepare(`UPDATE messages SET ${column} = ? WHERE id = ?`).run(text, msgId));
  } else {
    // No caption: fold into body so it shows in exports and the FTS index picks
    // it up (the messages_fts triggers fire on body updates).
    withFtsRecovery(() =>
      db.prepare(`UPDATE messages SET ${column} = ?, body = ? WHERE id = ?`).run(text, text, msgId)
    );
  }

  return { msgId, capability, backend: config.enrich[capability].backend, chars: text.length };
}

export interface PruneOptions {
  olderThanSec?: number;
  chatJid?: string;
  dryRun?: boolean;
}

export interface PruneResult {
  pruned: number;
  freed_bytes: number;
  missing: number;
}

// Delete downloaded media files (the markdown/manifest dumps are the durable
// record; the bytes are disposable and pile up on both VPS and laptop). Clears
// media_path so a later read knows the file is gone.
export function pruneMedia(opts: PruneOptions = {}): PruneResult {
  const db = getDb();
  const conditions = ["media_path IS NOT NULL"];
  const params: unknown[] = [];
  if (opts.olderThanSec) {
    conditions.push("timestamp < ?");
    params.push(Math.floor(Date.now() / 1000) - opts.olderThanSec);
  }
  if (opts.chatJid) {
    conditions.push("chat_jid = ?");
    params.push(opts.chatJid);
  }

  const rows = db
    .prepare(`SELECT id, media_path FROM messages WHERE ${conditions.join(" AND ")}`)
    .all(...params) as Array<{ id: string; media_path: string }>;

  const clear = db.prepare("UPDATE messages SET media_path = NULL WHERE id = ?");
  let pruned = 0;
  let freed = 0;
  let missing = 0;

  for (const row of rows) {
    let size = 0;
    let present = false;
    try {
      size = statSync(row.media_path).size;
      present = true;
    } catch {
      missing++;
    }
    if (!opts.dryRun) {
      if (present) {
        try { unlinkSync(row.media_path); } catch { /* already gone */ }
      }
      clear.run(row.id);
    }
    if (present) {
      pruned++;
      freed += size;
    }
  }

  return { pruned, freed_bytes: freed, missing };
}
