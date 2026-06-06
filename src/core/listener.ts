import type { WASocket, WAMessage, proto } from "@whiskeysockets/baileys";
import type { WuConfig } from "../config/schema.js";
import { shouldCollect } from "./constraints.js";
import { FifoDedup } from "./dedup.js";
import {
  getMessageContent,
  extractText,
  extractMessageType,
  extractSystemEvent,
  extractQuotedId,
  extractLocationData,
  extractMediaInfo,
  extractMediaResumeMetadata,
} from "./extract.js";
import {
  upsertMessage,
  upsertChat,
  upsertContact,
  bulkUpsertMessages,
  bulkUpsertChats,
  bulkUpsertContacts,
  upsertGroupParticipants,
  markMessageDeleted,
  serializeWAMessage,
  type MessageRow,
} from "./store.js";
import { createChildLogger } from "../config/logger.js";

const logger = createChildLogger("listener");

export interface ParsedMessage {
  id: string;
  chatJid: string;
  senderJid: string | null;
  senderName: string | null;
  body: string | null;
  type: string;
  isFromMe: boolean;
  timestamp: number;
  mediaMime: string | null;
  mediaSize: number | null;
  quotedId: string | null;
  raw: WAMessage;
}

export interface ListenerOptions {
  config: WuConfig;
  quiet?: boolean;
  onMessage?: (msg: ParsedMessage) => void;
}

function isStatusOrBroadcast(jid: string): boolean {
  return jid === "status@broadcast" || jid.endsWith("@broadcast");
}

function safeHandler(
  name: string,
  fn: (...args: any[]) => void
): (...args: any[]) => void {
  return (...args: any[]) => {
    try {
      fn(...args);
    } catch (err) {
      logger.error({ err, handler: name }, "Error in event handler");
    }
  };
}

function parseMessage(msg: WAMessage): ParsedMessage | null {
  const jid = msg.key.remoteJid;
  if (!jid) return null;

  const content = getMessageContent(msg);
  let type = extractMessageType(content);
  let text = extractText(content);
  // System events (joins, leaves, renames, ...) carry no message content but
  // a messageStubType — label them instead of dropping them into "unknown".
  if (type === "unknown") {
    const event = extractSystemEvent(msg);
    if (event) {
      type = "system";
      text = event;
    }
  }
  const loc = extractLocationData(content);
  const media = extractMediaInfo(content);
  const quotedId = extractQuotedId(content);
  const ts =
    typeof msg.messageTimestamp === "number"
      ? msg.messageTimestamp
      : typeof msg.messageTimestamp === "object" && msg.messageTimestamp != null
        ? Number(msg.messageTimestamp)
        : Math.floor(Date.now() / 1000);

  return {
    id: msg.key.id!,
    chatJid: jid,
    senderJid: msg.key.participant || (msg.key.fromMe ? null : jid),
    senderName: msg.pushName || null,
    body: text,
    type,
    isFromMe: msg.key.fromMe ?? false,
    timestamp: ts,
    mediaMime: media?.mime || null,
    mediaSize: media?.size || null,
    quotedId,
    raw: msg,
  };
}

function parsedToRow(
  parsed: ParsedMessage,
  content: ReturnType<typeof getMessageContent>
): Omit<MessageRow, "created_at"> {
  const loc = extractLocationData(content);
  const mediaMeta = extractMediaResumeMetadata(content);
  return {
    id: parsed.id,
    chat_jid: parsed.chatJid,
    sender_jid: parsed.senderJid,
    sender_name: parsed.senderName,
    body: parsed.body,
    type: parsed.type,
    media_mime: parsed.mediaMime,
    media_path: null,
    media_size: parsed.mediaSize,
    media_direct_path: mediaMeta?.directPath || null,
    media_key: mediaMeta?.mediaKey || null,
    media_file_sha256: mediaMeta?.fileSha256 || null,
    media_file_enc_sha256: mediaMeta?.fileEncSha256 || null,
    media_file_length: mediaMeta?.fileLength || null,
    quoted_id: parsed.quotedId,
    location_lat: loc?.lat || null,
    location_lon: loc?.lon || null,
    location_name: loc?.name || null,
    is_from_me: parsed.isFromMe ? 1 : 0,
    timestamp: parsed.timestamp,
    raw: serializeWAMessage(parsed.raw),
  };
}

export function startListener(
  sock: WASocket,
  opts: ListenerOptions
): void {
  const { config } = opts;
  const dedup = new FifoDedup(10000);

  // --- messages.upsert ---
  sock.ev.on(
    "messages.upsert",
    safeHandler("messages.upsert", ({ messages, type }: { messages: WAMessage[]; type: string }) => {
      for (const msg of messages) {
        const jid = msg.key.remoteJid;
        if (!jid || isStatusOrBroadcast(jid)) continue;
        if (!shouldCollect(jid, config)) continue;

        const dedupKey = `${jid}:${msg.key.id}`;
        if (dedup.has(dedupKey)) continue;
        dedup.add(dedupKey);

        const parsed = parseMessage(msg);
        if (!parsed) continue;

        const content = getMessageContent(msg);
        const row = parsedToRow(parsed, content);
        upsertMessage(row);

        // Update chat's last_message_at
        const chatType = jid.endsWith("@g.us") ? "group" : "dm";
        upsertChat({
          jid,
          name: null,
          type: chatType,
          participant_count: null,
          description: null,
          last_message_at: parsed.timestamp,
        });

        // Update contact
        if (parsed.senderJid && parsed.senderName) {
          upsertContact({
            jid: parsed.senderJid,
            phone: parsed.senderJid.split("@")[0],
            push_name: parsed.senderName,
            saved_name: null,
            is_business: 0,
          });
        }

        // Stream to callback only for live messages (not history sync)
        if (type === "notify" && opts.onMessage) {
          opts.onMessage(parsed);
        }
      }
    })
  );

  // --- messages.update ---
  sock.ev.on(
    "messages.update",
    safeHandler("messages.update", (updates: any[]) => {
      for (const update of updates) {
        const jid = update.key?.remoteJid;
        if (!jid || isStatusOrBroadcast(jid)) continue;
        if (!shouldCollect(jid, config)) continue;

        // Handle message deletion/revocation
        if (update.update?.messageStubType === 1 || update.update?.message === null) {
          if (update.key?.id) {
            markMessageDeleted(update.key.id);
          }
        }
      }
    })
  );

  // --- messages.reaction ---
  sock.ev.on(
    "messages.reaction",
    safeHandler("messages.reaction", (reactions: any[]) => {
      for (const { key, reaction } of reactions) {
        const jid = key.remoteJid;
        if (!jid || isStatusOrBroadcast(jid)) continue;
        if (!shouldCollect(jid, config)) continue;

        const reactionKey = reaction.key;
        const ts =
          typeof reaction.senderTimestampMs === "number"
            ? Math.floor(reaction.senderTimestampMs / 1000)
            : Math.floor(Date.now() / 1000);

        upsertMessage({
          id: `reaction:${reactionKey?.id || key.id}:${reaction.text || ""}`,
          chat_jid: jid,
          sender_jid: reactionKey?.participant || reactionKey?.remoteJid || null,
          sender_name: null,
          body: reaction.text || null,
          type: "reaction",
          media_mime: null,
          media_path: null,
          media_size: null,
          media_direct_path: null,
          media_key: null,
          media_file_sha256: null,
          media_file_enc_sha256: null,
          media_file_length: null,
          quoted_id: key.id,
          location_lat: null,
          location_lon: null,
          location_name: null,
          is_from_me: reactionKey?.fromMe ? 1 : 0,
          timestamp: ts,
          raw: serializeWAMessage({ key, reaction }),
        });
      }
    })
  );

  // --- chats.upsert ---
  // Groups bypass the constraint gate when group_discovery is on. DMs are
  // always gated because their JID contains a phone number.
  sock.ev.on(
    "chats.upsert",
    safeHandler("chats.upsert", (chats: any[]) => {
      const now = Math.floor(Date.now() / 1000);
      const discoveryOn = config.whatsapp.group_discovery;
      for (const chat of chats) {
        if (!chat.id || isStatusOrBroadcast(chat.id)) continue;
        const isGroup = chat.id.endsWith("@g.us");
        const allow = isGroup ? discoveryOn || shouldCollect(chat.id, config) : shouldCollect(chat.id, config);
        if (!allow) continue;

        upsertChat({
          jid: chat.id,
          name: chat.name || chat.subject || null,
          type: isGroup ? "group" : "dm",
          participant_count: null,
          description: null,
          last_message_at: chat.conversationTimestamp
            ? Number(chat.conversationTimestamp)
            : null,
          last_seen_at: now,
        });
      }
    })
  );

  // --- chats.update ---
  sock.ev.on(
    "chats.update",
    safeHandler("chats.update", (updates: any[]) => {
      const now = Math.floor(Date.now() / 1000);
      const discoveryOn = config.whatsapp.group_discovery;
      for (const update of updates) {
        if (!update.id || isStatusOrBroadcast(update.id)) continue;
        const isGroup = update.id.endsWith("@g.us");
        const allow = isGroup ? discoveryOn || shouldCollect(update.id, config) : shouldCollect(update.id, config);
        if (!allow) continue;

        upsertChat({
          jid: update.id,
          name: update.name || update.subject || null,
          type: isGroup ? "group" : "dm",
          participant_count: null,
          description: null,
          last_message_at: update.conversationTimestamp
            ? Number(update.conversationTimestamp)
            : null,
          last_seen_at: now,
        });
      }
    })
  );

  // --- chats.delete ---
  sock.ev.on(
    "chats.delete",
    safeHandler("chats.delete", (_deletions: string[]) => {
      // We keep chat records — just log
      logger.debug({ count: _deletions.length }, "Chats deleted");
    })
  );

  // --- contacts.upsert ---
  sock.ev.on(
    "contacts.upsert",
    safeHandler("contacts.upsert", (contacts: any[]) => {
      for (const contact of contacts) {
        if (!contact.id) continue;
        upsertContact({
          jid: contact.id,
          phone: contact.id.split("@")[0],
          push_name: contact.notify || contact.name || null,
          saved_name: contact.name || null,
          is_business: contact.isBusiness ? 1 : 0,
        });
      }
    })
  );

  // --- contacts.update ---
  sock.ev.on(
    "contacts.update",
    safeHandler("contacts.update", (updates: any[]) => {
      for (const update of updates) {
        if (!update.id) continue;
        upsertContact({
          jid: update.id,
          phone: update.id.split("@")[0],
          push_name: update.notify || update.name || null,
          saved_name: update.name || null,
          is_business: 0,
        });
      }
    })
  );

  // --- groups.upsert ---
  // jid/name/community shape always cached when group_discovery is on (default)
  // so users can find groups to opt into. Description and participant JIDs
  // stay constraint-gated regardless of the flag.
  sock.ev.on(
    "groups.upsert",
    safeHandler("groups.upsert", (groups: any[]) => {
      const now = Math.floor(Date.now() / 1000);
      const discoveryOn = config.whatsapp.group_discovery;
      for (const group of groups) {
        if (!group.id) continue;
        const allowed = shouldCollect(group.id, config);
        if (!discoveryOn && !allowed) continue;

        upsertChat({
          jid: group.id,
          name: group.subject || null,
          type: "group",
          participant_count: group.participants?.length || null,
          description: allowed ? group.desc || null : null,
          last_message_at: null,
          last_seen_at: now,
          is_community: group.isCommunity ? 1 : 0,
          is_community_announce: group.isCommunityAnnounce ? 1 : 0,
          linked_parent: group.linkedParent || null,
        });

        if (group.participants && allowed) {
          upsertGroupParticipants(
            group.id,
            group.participants.map((p: any) => ({
              jid: p.id,
              isAdmin: p.admin === "admin" || p.admin === "superadmin",
              isSuperAdmin: p.admin === "superadmin",
            }))
          );
        }
      }
    })
  );

  // --- groups.update ---
  sock.ev.on(
    "groups.update",
    safeHandler("groups.update", (updates: any[]) => {
      const now = Math.floor(Date.now() / 1000);
      const discoveryOn = config.whatsapp.group_discovery;
      for (const update of updates) {
        if (!update.id) continue;
        const allowed = shouldCollect(update.id, config);
        if (!discoveryOn && !allowed) continue;

        upsertChat({
          jid: update.id,
          name: update.subject || null,
          type: "group",
          participant_count: null,
          description: allowed ? update.desc || null : null,
          last_message_at: null,
          last_seen_at: now,
          is_community: update.isCommunity != null ? (update.isCommunity ? 1 : 0) : null,
          is_community_announce:
            update.isCommunityAnnounce != null ? (update.isCommunityAnnounce ? 1 : 0) : null,
          linked_parent: update.linkedParent || null,
        });
      }
    })
  );

  // --- group-participants.update ---
  sock.ev.on(
    "group-participants.update",
    safeHandler(
      "group-participants.update",
      ({ id, participants, action }: { id: string; participants: string[]; action: string }) => {
        if (!shouldCollect(id, config)) return;
        logger.debug({ groupJid: id, participants, action }, "Group participants updated");
        // Full participant list refresh is expensive — just log for now.
        // A full refresh happens on groups.upsert or explicit wu groups info.
      }
    )
  );

  // --- messaging-history.set ---
  sock.ev.on(
    "messaging-history.set",
    safeHandler(
      "messaging-history.set",
      ({
        messages,
        chats,
        contacts,
        isLatest,
      }: {
        messages: WAMessage[];
        chats: any[];
        contacts: any[];
        isLatest: boolean;
      }) => {
        if (!opts.quiet) {
          logger.info(
            {
              messages: messages.length,
              chats: chats.length,
              contacts: contacts.length,
              isLatest,
            },
            "History sync received"
          );
        }

        // Bulk upsert chats. Groups bypass constraints (discovery surface)
        // when whatsapp.group_discovery is enabled; DMs stay gated because
        // the JID contains the contact's phone number.
        const now = Math.floor(Date.now() / 1000);
        const discoveryOn = config.whatsapp.group_discovery;
        const chatRows = chats
          .filter((c) => {
            if (!c.id || isStatusOrBroadcast(c.id)) return false;
            if (c.id.endsWith("@g.us")) {
              return discoveryOn || shouldCollect(c.id, config);
            }
            return shouldCollect(c.id, config);
          })
          .map((c) => ({
            jid: c.id,
            name: c.name || c.subject || null,
            type: (c.id.endsWith("@g.us") ? "group" : "dm") as string,
            participant_count: null,
            description: null,
            last_message_at: c.conversationTimestamp
              ? Number(c.conversationTimestamp)
              : null,
            last_seen_at: now,
          }));
        bulkUpsertChats(chatRows);

        // Bulk upsert contacts
        const contactRows = contacts
          .filter((c) => c.id)
          .map((c) => ({
            jid: c.id,
            phone: c.id.split("@")[0],
            push_name: c.notify || c.name || null,
            saved_name: c.name || null,
            is_business: 0,
          }));
        bulkUpsertContacts(contactRows);

        // Bulk upsert messages
        const msgRows: Omit<MessageRow, "created_at">[] = [];
        for (const msg of messages) {
          const jid = msg.key.remoteJid;
          if (!jid || isStatusOrBroadcast(jid)) continue;
          if (!shouldCollect(jid, config)) continue;

          const parsed = parseMessage(msg);
          if (!parsed) continue;

          const content = getMessageContent(msg);
          msgRows.push(parsedToRow(parsed, content));
        }
        bulkUpsertMessages(msgRows);
      }
    )
  );

  if (!opts.quiet) logger.info("Listener started — collecting messages");
}
