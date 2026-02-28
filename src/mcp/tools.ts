import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WASocket } from "@whiskeysockets/baileys";
import type { WuConfig } from "../config/schema.js";
import { loadConfig, saveConfig } from "../config/schema.js";
import { resolveConstraint, shouldCollect } from "../core/constraints.js";
import { sendText, sendMedia, sendReaction, deleteForEveryone } from "../core/sender.js";
import { downloadMedia } from "../core/media.js";
import { createGroup, leaveGroup, fetchAllGroups, fetchGroupMetadata, getInviteCode } from "../core/groups.js";
import {
  listChats, listMessages, searchMessages, searchChats,
  listContacts, searchContacts, getGroupParticipants,
  getMessageCount,
} from "../core/store.js";

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

export function registerTools(
  server: McpServer,
  getSock: () => WASocket | undefined,
  config: WuConfig
): void {
  // --- wu_messages_send ---
  server.tool(
    "wu_messages_send",
    "Send a WhatsApp message (text or media)",
    {
      to: z.string().describe("Recipient JID (e.g., 1234567890@s.whatsapp.net or group@g.us)"),
      message: z.string().optional().describe("Text message to send"),
      media_path: z.string().optional().describe("Path to media file to send"),
      caption: z.string().optional().describe("Caption for media"),
      reply_to: z.string().optional().describe("Message ID to reply to"),
    },
    async (params) => {
      const sock = getSock();
      if (!sock) return errorResult("Not connected to WhatsApp");

      try {
        let result;
        if (params.media_path) {
          result = await sendMedia(sock, params.to, params.media_path, config, {
            caption: params.caption || params.message,
            replyTo: params.reply_to,
          });
        } else if (params.message) {
          result = await sendText(sock, params.to, params.message, config, {
            replyTo: params.reply_to,
          });
        } else {
          return errorResult("Provide message or media_path");
        }
        return jsonResult({ id: result?.key?.id, timestamp: result?.messageTimestamp });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }
  );

  // --- wu_react ---
  server.tool(
    "wu_react",
    "React to a WhatsApp message with an emoji",
    {
      chat: z.string().describe("Chat JID"),
      message_id: z.string().describe("Message ID to react to"),
      emoji: z.string().describe("Emoji reaction (empty string to remove)"),
    },
    async (params) => {
      const sock = getSock();
      if (!sock) return errorResult("Not connected to WhatsApp");

      try {
        await sendReaction(sock, params.chat, params.message_id, params.emoji, config);
        return jsonResult({ success: true });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }
  );

  // --- wu_media_download ---
  server.tool(
    "wu_media_download",
    "Download media from a WhatsApp message",
    {
      message_id: z.string().describe("Message ID with media"),
      out_dir: z.string().optional().describe("Output directory"),
    },
    async (params) => {
      const sock = getSock();
      if (!sock) return errorResult("Not connected to WhatsApp");

      try {
        const result = await downloadMedia(
          params.message_id,
          sock,
          config,
          params.out_dir
        );
        return jsonResult(result);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }
  );

  // --- wu_groups_create ---
  server.tool(
    "wu_groups_create",
    "Create a new WhatsApp group",
    {
      name: z.string().describe("Group name"),
      participants: z.array(z.string()).describe("Participant JIDs"),
    },
    async (params) => {
      const sock = getSock();
      if (!sock) return errorResult("Not connected to WhatsApp");

      try {
        const result = await createGroup(
          sock,
          params.name,
          params.participants,
          config
        );
        return jsonResult({ id: result.id, name: result.subject });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }
  );

  // --- wu_groups_leave ---
  server.tool(
    "wu_groups_leave",
    "Leave a WhatsApp group",
    {
      jid: z.string().describe("Group JID"),
    },
    async (params) => {
      const sock = getSock();
      if (!sock) return errorResult("Not connected to WhatsApp");

      try {
        await leaveGroup(sock, params.jid, config);
        return jsonResult({ success: true });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }
  );

  // --- wu_messages_search ---
  server.tool(
    "wu_messages_search",
    "Search WhatsApp messages by text content",
    {
      query: z.string().describe("Search query"),
      chat: z.string().optional().describe("Filter by chat JID"),
      from: z.string().optional().describe("Filter by sender JID"),
      limit: z.number().optional().default(50).describe("Max results"),
    },
    async (params) => {
      try {
        const cfg = loadConfig();
        const allResults = searchMessages(params.query, {
          chatJid: params.chat,
          senderJid: params.from,
          limit: 10000,
        });
        const results = allResults.filter((r) => shouldCollect(r.chat_jid, cfg)).slice(0, params.limit);
        return jsonResult(
          results.map((r) => ({
            id: r.id,
            chat_jid: r.chat_jid,
            sender_name: r.sender_name,
            body: r.body,
            type: r.type,
            timestamp: r.timestamp,
          }))
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }
  );

  // --- wu_chats_list ---
  server.tool(
    "wu_chats_list",
    "List all WhatsApp chats",
    {
      limit: z.number().optional().default(100).describe("Max chats"),
    },
    async (params) => {
      const cfg = loadConfig();
      const allChats = listChats({ limit: 10000 });
      const chats = allChats.filter((c) => shouldCollect(c.jid, cfg)).slice(0, params.limit);
      return jsonResult(
        chats.map((c) => ({
          jid: c.jid,
          name: c.name,
          type: c.type,
          last_message_at: c.last_message_at,
        }))
      );
    }
  );

  // --- wu_messages_list ---
  server.tool(
    "wu_messages_list",
    "List messages in a WhatsApp chat",
    {
      chat: z.string().describe("Chat JID"),
      limit: z.number().optional().default(50).describe("Max messages"),
      before: z.number().optional().describe("Before timestamp (unix)"),
      after: z.number().optional().describe("After timestamp (unix)"),
    },
    async (params) => {
      const cfg = loadConfig();
      if (!shouldCollect(params.chat, cfg)) {
        return errorResult(`Chat ${params.chat} is blocked by constraints`);
      }
      const messages = listMessages({
        chatJid: params.chat,
        limit: params.limit,
        before: params.before,
        after: params.after,
      });
      return jsonResult(
        messages.map((m) => ({
          id: m.id,
          sender: m.sender_jid,
          sender_name: m.sender_name,
          body: m.body,
          type: m.type,
          timestamp: m.timestamp,
          has_media: !!(m.media_mime || m.media_path),
        }))
      );
    }
  );

  // --- wu_contacts_list ---
  server.tool(
    "wu_contacts_list",
    "List all WhatsApp contacts",
    {
      limit: z.number().optional().default(100).describe("Max contacts"),
    },
    async (params) => {
      const contacts = listContacts({ limit: params.limit });
      return jsonResult(
        contacts.map((c) => ({
          jid: c.jid,
          phone: c.phone,
          push_name: c.push_name,
        }))
      );
    }
  );

  // --- wu_status ---
  server.tool(
    "wu_status",
    "Get WhatsApp connection status",
    {},
    async () => {
      const sock = getSock();
      return jsonResult({
        connected: sock ? (sock.ws as any)?.isOpen ?? false : false,
        messages_stored: getMessageCount(),
        timestamp: Date.now(),
      });
    }
  );

  // --- wu_chats_search ---
  server.tool(
    "wu_chats_search",
    "Search WhatsApp chats by name",
    {
      query: z.string().describe("Search query"),
      limit: z.number().optional().default(100).describe("Max results"),
    },
    async (params) => {
      const cfg = loadConfig();
      const allChats = searchChats(params.query, { limit: 10000 });
      const chats = allChats.filter((c) => shouldCollect(c.jid, cfg)).slice(0, params.limit);
      return jsonResult(
        chats.map((c) => ({
          jid: c.jid,
          name: c.name,
          type: c.type,
          last_message_at: c.last_message_at,
        }))
      );
    }
  );

  // --- wu_contacts_search ---
  server.tool(
    "wu_contacts_search",
    "Search WhatsApp contacts by name or phone",
    {
      query: z.string().describe("Search query"),
      limit: z.number().optional().default(100).describe("Max results"),
    },
    async (params) => {
      const contacts = searchContacts(params.query, { limit: params.limit });
      return jsonResult(
        contacts.map((c) => ({
          jid: c.jid,
          phone: c.phone,
          push_name: c.push_name,
          saved_name: c.saved_name,
        }))
      );
    }
  );

  // --- wu_groups_list ---
  server.tool(
    "wu_groups_list",
    "List WhatsApp groups (cached from DB, or live from WhatsApp with live=true)",
    {
      live: z.boolean().optional().default(false).describe("Fetch live from WhatsApp instead of cache"),
      limit: z.number().optional().default(100).describe("Max results"),
    },
    async (params) => {
      if (params.live) {
        const sock = getSock();
        if (!sock) return errorResult("Not connected to WhatsApp");
        try {
          const cfg = loadConfig();
          const groups = await fetchAllGroups(sock);
          const filtered = Object.values(groups)
            .filter((g: any) => shouldCollect(g.id, cfg))
            .slice(0, params.limit);
          return jsonResult(
            filtered.map((g: any) => ({
              jid: g.id,
              name: g.subject,
              participant_count: g.participants?.length ?? 0,
            }))
          );
        } catch (err) {
          return errorResult((err as Error).message);
        }
      }
      const cfg = loadConfig();
      const allChats = listChats({ limit: 10000 });
      const chats = allChats
        .filter((c) => c.type === "group" && shouldCollect(c.jid, cfg))
        .slice(0, params.limit);
      return jsonResult(
        chats.map((c) => ({
          jid: c.jid,
          name: c.name,
          participant_count: c.participant_count,
          last_message_at: c.last_message_at,
        }))
      );
    }
  );

  // --- wu_groups_info ---
  server.tool(
    "wu_groups_info",
    "Get group details and participants",
    {
      jid: z.string().describe("Group JID"),
      live: z.boolean().optional().default(false).describe("Fetch live from WhatsApp"),
    },
    async (params) => {
      const cfg = loadConfig();
      if (!shouldCollect(params.jid, cfg)) {
        return errorResult(`Group ${params.jid} is blocked by constraints`);
      }
      if (params.live) {
        const sock = getSock();
        if (!sock) return errorResult("Not connected to WhatsApp");
        try {
          const meta = await fetchGroupMetadata(sock, params.jid);
          return jsonResult(meta);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      }
      const participants = getGroupParticipants(params.jid);
      const chats = listChats({ limit: 10000 });
      const group = chats.find((c) => c.jid === params.jid);
      return jsonResult({
        jid: params.jid,
        name: group?.name,
        description: group?.description,
        participant_count: group?.participant_count,
        participants: participants.map((p) => ({
          jid: p.participant_jid,
          is_admin: !!p.is_admin,
          is_super_admin: !!p.is_super_admin,
        })),
      });
    }
  );

  // --- wu_groups_invite ---
  server.tool(
    "wu_groups_invite",
    "Get group invite link",
    {
      jid: z.string().describe("Group JID"),
    },
    async (params) => {
      const sock = getSock();
      if (!sock) return errorResult("Not connected to WhatsApp");
      try {
        const code = await getInviteCode(sock, params.jid, config);
        return jsonResult({ link: `https://chat.whatsapp.com/${code}` });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }
  );

  // --- wu_constraints_list ---
  server.tool(
    "wu_constraints_list",
    "List all constraints (what chats the agent can access and at what level)",
    {},
    async () => {
      const cfg = loadConfig();
      const defaultMode = cfg.constraints?.default ?? "none";
      const chats = cfg.constraints?.chats ?? {};
      return jsonResult({
        default: defaultMode,
        chats: Object.entries(chats).map(([jid, c]) => ({
          jid,
          mode: c.mode,
        })),
      });
    }
  );

  // --- wu_constraints_set ---
  server.tool(
    "wu_constraints_set",
    "Set a constraint for a chat (allow/block). Mode: full (read+write+manage), read (collect only), none (blocked)",
    {
      jid: z.string().describe("Chat JID or wildcard (e.g. *@g.us)"),
      mode: z.enum(["full", "read", "none"]).describe("Constraint mode"),
    },
    async (params) => {
      const cfg = loadConfig();
      if (!cfg.constraints) {
        cfg.constraints = { default: "none", chats: {} };
      }
      cfg.constraints.chats[params.jid] = { mode: params.mode };
      saveConfig(cfg);
      return jsonResult({ jid: params.jid, mode: params.mode });
    }
  );

  // --- wu_constraints_remove ---
  server.tool(
    "wu_constraints_remove",
    "Remove a per-chat constraint (falls back to default)",
    {
      jid: z.string().describe("Chat JID to remove constraint for"),
    },
    async (params) => {
      const cfg = loadConfig();
      if (cfg.constraints?.chats) {
        delete cfg.constraints.chats[params.jid];
        saveConfig(cfg);
      }
      return jsonResult({ removed: params.jid });
    }
  );

  // --- wu_constraints_default ---
  server.tool(
    "wu_constraints_default",
    "Get or set the default constraint mode",
    {
      mode: z.enum(["full", "read", "none"]).optional().describe("New default mode (omit to just read current)"),
    },
    async (params) => {
      if (params.mode) {
        const cfg = loadConfig();
        if (!cfg.constraints) {
          cfg.constraints = { default: params.mode, chats: {} };
        } else {
          cfg.constraints.default = params.mode;
        }
        saveConfig(cfg);
        return jsonResult({ default: params.mode });
      }
      const cfg = loadConfig();
      return jsonResult({ default: cfg.constraints?.default ?? "none" });
    }
  );

  // --- wu_config_show ---
  server.tool(
    "wu_config_show",
    "Show current wu configuration",
    {},
    async () => {
      const cfg = loadConfig();
      return jsonResult(cfg);
    }
  );
}
