import type { WASocket, WAMessageKey } from "@whiskeysockets/baileys";
import type { WuConfig } from "../config/schema.js";
import { getDb } from "../db/database.js";
import { createChildLogger } from "../config/logger.js";

const logger = createChildLogger("backfill");

export async function backfillHistory(
  sock: WASocket,
  jid: string,
  count: number,
  config: WuConfig,
  opts?: { timeoutMs?: number },
): Promise<{ requested: number; newMessages: number; oldestTimestamp: number | null }> {
  const db = getDb();
  const timeoutMs = opts?.timeoutMs ?? 30_000;

  // Find oldest real message in chat (skip unknown/protocol messages)
  const oldest = db
    .prepare("SELECT id, timestamp, is_from_me FROM messages WHERE chat_jid = ? AND type != 'unknown' ORDER BY timestamp ASC LIMIT 1")
    .get(jid) as { id: string; timestamp: number; is_from_me: number } | undefined;

  if (!oldest) {
    throw new Error(`No messages for ${jid}. Listen or sync first to get a reference message.`);
  }

  const countBefore = (
    db.prepare("SELECT COUNT(*) as c FROM messages WHERE chat_jid = ?").get(jid) as { c: number }
  ).c;

  const key: WAMessageKey = {
    remoteJid: jid,
    id: oldest.id,
    fromMe: oldest.is_from_me === 1,
  };

  logger.info({ jid, count, oldestId: oldest.id, oldestTs: oldest.timestamp }, "Requesting history backfill");

  // Baileys assigns this to oldestMsgTimestampMs — needs milliseconds
  const sessionId = await (sock as any).fetchMessageHistory(count, key, oldest.timestamp * 1000);

  // Wait for messaging-history.set events
  await new Promise<void>((resolve) => {
    let totalNew = 0;
    const timer = setTimeout(() => {
      logger.debug({ totalNew }, "Backfill timeout reached");
      sock.ev.off("messaging-history.set", handler);
      resolve();
    }, timeoutMs);

    function handler(data: {
      messages: any[];
      peerDataRequestSessionId?: string | null;
    }) {
      if (data.peerDataRequestSessionId && data.peerDataRequestSessionId !== sessionId) return;

      const forChat = data.messages.filter(
        (m: any) => m.key?.remoteJid === jid,
      );
      totalNew += forChat.length;
      logger.debug({ chunk: forChat.length, totalNew }, "History chunk received");

      if (totalNew >= count) {
        clearTimeout(timer);
        sock.ev.off("messaging-history.set", handler);
        resolve();
      }
    }

    sock.ev.on("messaging-history.set", handler);
  });

  // Count new messages
  const countAfter = (
    db.prepare("SELECT COUNT(*) as c FROM messages WHERE chat_jid = ?").get(jid) as { c: number }
  ).c;

  const newOldest = db
    .prepare("SELECT timestamp FROM messages WHERE chat_jid = ? ORDER BY timestamp ASC LIMIT 1")
    .get(jid) as { timestamp: number } | undefined;

  return {
    requested: count,
    newMessages: countAfter - countBefore,
    oldestTimestamp: newOldest?.timestamp ?? null,
  };
}
