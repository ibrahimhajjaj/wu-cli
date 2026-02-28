import {
  downloadMediaMessage,
  downloadContentFromMessage,
  type WASocket,
  type WAMessage,
  type MediaType,
} from "@whiskeysockets/baileys";
import { writeFileSync, mkdirSync } from "fs";
import { join, extname } from "path";
import type { WuConfig } from "../config/schema.js";
import { getMessage, upsertMessage, deserializeWAMessage, type MessageRow } from "./store.js";
import { MEDIA_DIR } from "../config/paths.js";
import { createChildLogger } from "../config/logger.js";
import { asyncPool } from "./pool.js";
import { getDb } from "../db/database.js";

const logger = createChildLogger("media");

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
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${msgId}${ext}`);
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
