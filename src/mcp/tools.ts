import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WASocket } from "@whiskeysockets/baileys";
import type { WuConfig, RemoteConfig } from "../config/schema.js";
import { loadConfig, saveConfig } from "../config/schema.js";
import { resolveConstraint, shouldCollect } from "../core/constraints.js";
import { existsSync, unlinkSync } from "fs";
import { DB_PATH } from "../config/paths.js";
import { closeDb, reloadDb } from "../db/database.js";
import { sendText, sendMedia, sendReaction, deleteForEveryone } from "../core/sender.js";
import { downloadMedia, downloadMediaBatch } from "../core/media.js";
import { createGroup, leaveGroup, fetchAllGroups, fetchGroupMetadata, getInviteCode, renameGroup, joinGroupByInvite } from "../core/groups.js";
import { backfillHistory } from "../core/backfill.js";
import {
  listChats, listMessages, searchMessages, searchChats,
  listContacts, searchContacts, getGroupParticipants,
  getMessageCount, getMessageContext, upsertMessage,
} from "../core/store.js";
import { getDb } from "../db/database.js";
import { sshWuExec, syncDb } from "../core/remote.js";

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
  config: WuConfig,
  remote?: { name: string; remote: RemoteConfig },
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
      if (sock) {
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

      if (remote) {
        try {
          const args = ["messages", "send", params.to];
          if (params.message) args.push(params.message);
          if (params.media_path) args.push("--media", params.media_path);
          if (params.caption) args.push("--caption", params.caption);
          if (params.reply_to) args.push("--reply-to", params.reply_to);
          args.push("--json");

          const sshResult = await sshWuExec(remote.remote, args);
          if (sshResult.exitCode !== 0) {
            return errorResult(`Remote send failed: ${sshResult.stderr}`);
          }
          const sent = JSON.parse(sshResult.stdout);

          // Inject into local DB for write-read consistency
          upsertMessage({
            id: sent.id,
            chat_jid: params.to,
            sender_jid: null,
            sender_name: null,
            body: params.message || null,
            type: "text",
            media_mime: null, media_path: null, media_size: null,
            media_direct_path: null, media_key: null, media_file_sha256: null,
            media_file_enc_sha256: null, media_file_length: null,
            quoted_id: params.reply_to || null,
            location_lat: null, location_lon: null, location_name: null,
            is_from_me: 1,
            timestamp: sent.timestamp || Math.floor(Date.now() / 1000),
            raw: null,
          });

          return jsonResult(sent);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      }

      return errorResult("Not connected to WhatsApp and no remote configured");
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
      if (sock) {
        try {
          await sendReaction(sock, params.chat, params.message_id, params.emoji, config);
          return jsonResult({ success: true });
        } catch (err) {
          return errorResult((err as Error).message);
        }
      }

      if (remote) {
        try {
          const sshResult = await sshWuExec(remote.remote, [
            "messages", "react", params.chat, params.message_id, params.emoji,
          ]);
          if (sshResult.exitCode !== 0) {
            return errorResult(`Remote react failed: ${sshResult.stderr}`);
          }
          return jsonResult({ success: true });
        } catch (err) {
          return errorResult((err as Error).message);
        }
      }

      return errorResult("Not connected to WhatsApp and no remote configured");
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
      if (!sock) return errorResult("Not connected to WhatsApp (media download requires local connection)");

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
      if (sock) {
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

      if (remote) {
        try {
          const sshResult = await sshWuExec(remote.remote, [
            "groups", "create", params.name, ...params.participants,
          ]);
          if (sshResult.exitCode !== 0) {
            return errorResult(`Remote group create failed: ${sshResult.stderr}`);
          }
          return jsonResult(JSON.parse(sshResult.stdout));
        } catch (err) {
          return errorResult((err as Error).message);
        }
      }

      return errorResult("Not connected to WhatsApp and no remote configured");
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
      if (sock) {
        try {
          await leaveGroup(sock, params.jid, config);
          return jsonResult({ success: true });
        } catch (err) {
          return errorResult((err as Error).message);
        }
      }

      if (remote) {
        try {
          const sshResult = await sshWuExec(remote.remote, [
            "groups", "leave", params.jid,
          ]);
          if (sshResult.exitCode !== 0) {
            return errorResult(`Remote group leave failed: ${sshResult.stderr}`);
          }
          return jsonResult({ success: true });
        } catch (err) {
          return errorResult((err as Error).message);
        }
      }

      return errorResult("Not connected to WhatsApp and no remote configured");
    }
  );

  // --- wu_messages_search ---
  server.tool(
    "wu_messages_search",
    "Search WhatsApp messages by text content (FTS5 full-text search with relevance ranking)",
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
            snippet: r.snippet,
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
        remote_mode: !!remote,
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
      if (sock) {
        try {
          const code = await getInviteCode(sock, params.jid, config);
          return jsonResult({ link: `https://chat.whatsapp.com/${code}` });
        } catch (err) {
          return errorResult((err as Error).message);
        }
      }

      if (remote) {
        try {
          const sshResult = await sshWuExec(remote.remote, [
            "groups", "invite", params.jid,
          ]);
          if (sshResult.exitCode !== 0) {
            return errorResult(`Remote invite failed: ${sshResult.stderr}`);
          }
          // Parse invite code from output
          const match = sshResult.stdout.match(/https:\/\/chat\.whatsapp\.com\/\S+/);
          if (match) return jsonResult({ link: match[0] });
          return jsonResult({ output: sshResult.stdout.trim() });
        } catch (err) {
          return errorResult((err as Error).message);
        }
      }

      return errorResult("Not connected to WhatsApp and no remote configured");
    }
  );

  // --- wu_messages_context ---
  server.tool(
    "wu_messages_context",
    "Get surrounding messages (before/after) for a specific message — useful for understanding conversation context",
    {
      message_id: z.string().describe("Message ID to get context for"),
      before: z.number().optional().default(10).describe("Number of messages before"),
      after: z.number().optional().default(10).describe("Number of messages after"),
    },
    async (params) => {
      try {
        const result = getMessageContext(params.message_id, {
          beforeCount: params.before,
          afterCount: params.after,
        });
        if (!result) return errorResult(`Message not found: ${params.message_id}`);
        const fmt = (m: any) => ({
          id: m.id,
          sender: m.sender_jid,
          sender_name: m.sender_name,
          body: m.body,
          type: m.type,
          timestamp: m.timestamp,
        });
        return jsonResult({
          chat_jid: result.target.chat_jid,
          target: fmt(result.target),
          before: result.before.map(fmt),
          after: result.after.map(fmt),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }
  );

  // --- wu_history_backfill ---
  server.tool(
    "wu_history_backfill",
    "Request older message history from WhatsApp for a chat (on-demand backfill)",
    {
      jid: z.string().describe("Chat JID to backfill"),
      count: z.number().optional().default(50).describe("Number of messages to request"),
      timeout_ms: z.number().optional().default(30000).describe("Timeout in ms"),
    },
    async (params) => {
      const sock = getSock();
      if (sock) {
        try {
          const result = await backfillHistory(sock, params.jid, params.count, config, {
            timeoutMs: params.timeout_ms,
          });
          return jsonResult(result);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      }

      if (remote) {
        try {
          const sshResult = await sshWuExec(remote.remote, [
            "history", "backfill", params.jid,
            "--count", String(params.count),
            "--timeout", String(params.timeout_ms),
            "--json",
          ]);
          if (sshResult.exitCode !== 0) {
            return errorResult(`Remote backfill failed: ${sshResult.stderr}`);
          }
          const result = JSON.parse(sshResult.stdout);

          // Sync DB to pull new messages locally
          try {
            await syncDb(remote.remote, DB_PATH);
            reloadDb();
          } catch { /* best effort */ }

          return jsonResult(result);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      }

      return errorResult("Not connected to WhatsApp and no remote configured");
    }
  );

  // --- wu_media_download_batch ---
  server.tool(
    "wu_media_download_batch",
    "Download media from multiple WhatsApp messages in parallel",
    {
      message_ids: z.array(z.string()).optional().describe("Specific message IDs to download"),
      chat: z.string().optional().describe("Chat JID — find undownloaded media in this chat"),
      limit: z.number().optional().default(50).describe("Max messages to download (when using chat)"),
      concurrency: z.number().optional().default(4).describe("Parallel download workers"),
    },
    async (params) => {
      const sock = getSock();
      if (!sock) {
        if (remote) {
          try {
            const args = ["media", "download-batch"];
            if (params.chat) args.push(params.chat);
            if (params.limit) args.push("--limit", String(params.limit));
            if (params.concurrency) args.push("--concurrency", String(params.concurrency));
            args.push("--json");

            const sshResult = await sshWuExec(remote.remote, args);
            if (sshResult.exitCode !== 0) {
              return errorResult(`Remote batch download failed: ${sshResult.stderr}`);
            }
            return jsonResult(JSON.parse(sshResult.stdout));
          } catch (err) {
            return errorResult((err as Error).message);
          }
        }
        return errorResult("Not connected to WhatsApp (media download requires connection)");
      }

      try {
        let ids = params.message_ids;
        if (!ids || ids.length === 0) {
          if (!params.chat) return errorResult("Provide message_ids or chat");
          const db = getDb();
          const rows = db
            .prepare(
              "SELECT id FROM messages WHERE media_mime IS NOT NULL AND media_path IS NULL AND chat_jid = ? ORDER BY timestamp DESC LIMIT ?"
            )
            .all(params.chat, params.limit) as Array<{ id: string }>;
          ids = rows.map((r) => r.id);
          if (ids.length === 0) return jsonResult({ results: [], errors: [], message: "No undownloaded media found" });
        }

        const { results, errors } = await downloadMediaBatch(ids, sock, config, undefined, {
          concurrency: params.concurrency,
        });
        return jsonResult({ results, errors });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }
  );

  // --- wu_groups_rename ---
  server.tool(
    "wu_groups_rename",
    "Rename a WhatsApp group",
    {
      jid: z.string().describe("Group JID"),
      name: z.string().describe("New group name"),
    },
    async (params) => {
      const sock = getSock();
      if (sock) {
        try {
          await renameGroup(sock, params.jid, params.name, config);
          return jsonResult({ success: true, jid: params.jid, name: params.name });
        } catch (err) {
          return errorResult((err as Error).message);
        }
      }

      if (remote) {
        try {
          const sshResult = await sshWuExec(remote.remote, [
            "groups", "rename", params.jid, params.name,
          ]);
          if (sshResult.exitCode !== 0) {
            return errorResult(`Remote rename failed: ${sshResult.stderr}`);
          }
          return jsonResult({ success: true, jid: params.jid, name: params.name });
        } catch (err) {
          return errorResult((err as Error).message);
        }
      }

      return errorResult("Not connected to WhatsApp and no remote configured");
    }
  );

  // --- wu_groups_join ---
  server.tool(
    "wu_groups_join",
    "Join a WhatsApp group by invite code or URL",
    {
      code: z.string().describe("Invite code or full URL (e.g. https://chat.whatsapp.com/ABC123)"),
    },
    async (params) => {
      const sock = getSock();
      if (sock) {
        try {
          const jid = await joinGroupByInvite(sock, params.code);
          return jsonResult({ success: true, jid });
        } catch (err) {
          return errorResult((err as Error).message);
        }
      }

      if (remote) {
        try {
          const sshResult = await sshWuExec(remote.remote, [
            "groups", "join", params.code,
          ]);
          if (sshResult.exitCode !== 0) {
            return errorResult(`Remote join failed: ${sshResult.stderr}`);
          }
          return jsonResult({ success: true, output: sshResult.stdout.trim() });
        } catch (err) {
          return errorResult((err as Error).message);
        }
      }

      return errorResult("Not connected to WhatsApp and no remote configured");
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

  // --- wu_sync_pull ---
  if (remote) {
    server.tool(
      "wu_sync_pull",
      "Pull the latest database from the remote server (refreshes local data)",
      {},
      async () => {
        try {
          await syncDb(remote.remote, DB_PATH);
          reloadDb();
          const count = getMessageCount();
          return jsonResult({ message: "Sync complete", messages_stored: count });
        } catch (err) {
          return errorResult((err as Error).message);
        }
      }
    );
  }

  // --- wu_db_reset ---
  server.tool(
    "wu_db_reset",
    "Delete the database and start fresh. Removes all collected messages, chats, and contacts.",
    {
      confirm: z.boolean().describe("Must be true to confirm the reset"),
    },
    async (params) => {
      if (!params.confirm) {
        return errorResult("Set confirm: true to reset the database");
      }
      if (!existsSync(DB_PATH)) {
        return jsonResult({ message: "No database found. Nothing to reset." });
      }
      closeDb();
      unlinkSync(DB_PATH);
      for (const suffix of ["-wal", "-shm"]) {
        const p = DB_PATH + suffix;
        if (existsSync(p)) unlinkSync(p);
      }
      return jsonResult({ message: "Database deleted. Run wu daemon or wu listen to start collecting again." });
    }
  );
}
