import type { WASocket, WAMessage } from "@whiskeysockets/baileys";
import { readFileSync } from "fs";
import { extname } from "path";
import type { WuConfig } from "../config/schema.js";
import { assertCanSend } from "./constraints.js";
import { getMessage, deserializeWAMessage } from "./store.js";
import { createChildLogger } from "../config/logger.js";

const logger = createChildLogger("sender");

let lastSendTime = 0;

async function rateLimit(config: WuConfig): Promise<void> {
  const delay = config.whatsapp.send_delay_ms;
  const now = Date.now();
  const elapsed = now - lastSendTime;
  if (elapsed < delay) {
    await new Promise((resolve) => setTimeout(resolve, delay - elapsed));
  }
  lastSendTime = Date.now();
}

function getQuotedMessage(
  msgId: string
): WAMessage | undefined {
  const row = getMessage(msgId);
  if (!row?.raw) return undefined;
  return deserializeWAMessage(row.raw) as WAMessage;
}

const MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".avi": "video/avi",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg; codecs=opus",
  ".opus": "audio/ogg; codecs=opus",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip",
};

function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_MAP[ext] || "application/octet-stream";
}

export async function sendText(
  sock: WASocket,
  jid: string,
  text: string,
  config: WuConfig,
  opts?: { replyTo?: string }
): Promise<WAMessage | undefined> {
  assertCanSend(jid, config);
  await rateLimit(config);

  const sendOpts: Record<string, unknown> = {};
  if (opts?.replyTo) {
    const quoted = getQuotedMessage(opts.replyTo);
    if (quoted) sendOpts.quoted = quoted;
  }

  logger.debug({ jid, textLen: text.length }, "Sending text");
  return sock.sendMessage(jid, { text }, sendOpts);
}

export async function sendMedia(
  sock: WASocket,
  jid: string,
  filePath: string,
  config: WuConfig,
  opts?: { caption?: string; replyTo?: string }
): Promise<WAMessage | undefined> {
  assertCanSend(jid, config);
  await rateLimit(config);

  const mime = getMimeType(filePath);
  const buffer = readFileSync(filePath);
  const sendOpts: Record<string, unknown> = {};

  if (opts?.replyTo) {
    const quoted = getQuotedMessage(opts.replyTo);
    if (quoted) sendOpts.quoted = quoted;
  }

  let content: Record<string, unknown>;

  if (mime.startsWith("image/")) {
    content = { image: buffer, caption: opts?.caption, mimetype: mime };
  } else if (mime.startsWith("video/")) {
    content = { video: buffer, caption: opts?.caption, mimetype: mime };
  } else if (mime.startsWith("audio/")) {
    const isPtt = mime.includes("ogg");
    content = { audio: buffer, ptt: isPtt, mimetype: mime };
  } else {
    const fileName = filePath.split("/").pop() || "file";
    content = { document: buffer, fileName, mimetype: mime, caption: opts?.caption };
  }

  logger.debug({ jid, mime, size: buffer.length }, "Sending media");
  return sock.sendMessage(jid, content as any, sendOpts);
}

export async function sendReaction(
  sock: WASocket,
  jid: string,
  msgId: string,
  emoji: string,
  config: WuConfig
): Promise<WAMessage | undefined> {
  assertCanSend(jid, config);
  await rateLimit(config);

  // Read stored message to get correct fromMe value
  const stored = getMessage(msgId);
  const fromMe = stored ? stored.is_from_me === 1 : false;

  const key = {
    remoteJid: jid,
    id: msgId,
    fromMe,
  };

  logger.debug({ jid, msgId, emoji }, "Sending reaction");
  return sock.sendMessage(jid, { react: { text: emoji, key } });
}

export async function sendPoll(
  sock: WASocket,
  jid: string,
  question: string,
  options: string[],
  config: WuConfig
): Promise<WAMessage | undefined> {
  assertCanSend(jid, config);
  await rateLimit(config);

  logger.debug({ jid, question, options }, "Sending poll");
  return sock.sendMessage(jid, {
    poll: { name: question, values: options, selectableCount: 1 },
  } as any);
}

export async function deleteForEveryone(
  sock: WASocket,
  jid: string,
  msgId: string,
  config: WuConfig
): Promise<WAMessage | undefined> {
  assertCanSend(jid, config);
  await rateLimit(config);

  // Read stored message to get correct fromMe value
  const stored = getMessage(msgId);
  const fromMe = stored ? stored.is_from_me === 1 : false;

  const key = {
    remoteJid: jid,
    id: msgId,
    fromMe,
  };

  logger.debug({ jid, msgId, fromMe }, "Deleting message");
  return sock.sendMessage(jid, { delete: key });
}
