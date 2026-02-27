import {
  downloadMediaMessage,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
import { writeFileSync, mkdirSync } from "fs";
import { join, extname } from "path";
import type { WuConfig } from "../config/schema.js";
import { getMessage, deserializeWAMessage } from "./store.js";
import { MEDIA_DIR } from "../config/paths.js";
import { createChildLogger } from "../config/logger.js";

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

export async function downloadMedia(
  msgId: string,
  sock: WASocket,
  config: WuConfig,
  outDir?: string
): Promise<{ path: string; mime: string; size: number }> {
  const row = getMessage(msgId);
  if (!row?.raw) {
    throw new Error(`Message not found or no raw data: ${msgId}`);
  }

  const msg = deserializeWAMessage(row.raw) as WAMessage;

  // Check media size limit
  const maxBytes = (config.whatsapp.media_max_mb || 50) * 1024 * 1024;
  if (row.media_size && row.media_size > maxBytes) {
    throw new Error(
      `Media exceeds size limit (${(row.media_size / 1048576).toFixed(1)}MB > ${config.whatsapp.media_max_mb}MB)`
    );
  }

  let buffer: Buffer;
  try {
    buffer = (await downloadMediaMessage(msg, "buffer", {}, {
      reuploadRequest: (m) => sock.updateMediaMessage(m),
      logger: logger as any,
    })) as Buffer;
  } catch (err: unknown) {
    // On 410/404 (expired media), try re-upload
    const statusCode = (err as any)?.output?.statusCode || (err as any)?.statusCode;
    if (statusCode === 410 || statusCode === 404) {
      logger.warn({ msgId }, "Media expired, requesting re-upload");
      const updated = await sock.updateMediaMessage(msg);
      buffer = (await downloadMediaMessage(updated, "buffer", {}, {
        logger: logger as any,
      } as any)) as Buffer;
    } else {
      throw err;
    }
  }

  const mime = row.media_mime || "application/octet-stream";
  const ext = MIME_TO_EXT[mime] || extname(row.media_path || "") || ".bin";
  const dir = outDir || config.whatsapp.media_dir || MEDIA_DIR;
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${msgId}${ext}`);
  writeFileSync(filePath, buffer);

  logger.debug({ msgId, path: filePath, size: buffer.length }, "Media downloaded");

  return { path: filePath, mime, size: buffer.length };
}
