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
import { downloadMedia, downloadMediaBatch, pruneMedia, parseDuration, enrichMessage, resolveLocalMediaPath } from "../core/media.js";
import { enrichStatus, resolveBackend, type Capability } from "../core/enrich.js";
import { asyncPool } from "../core/pool.js";
import { daemonIpcAvailable, daemonRequest } from "../core/ipc.js";
import { createGroup, leaveGroup, fetchAllGroups, fetchGroupMetadata, getInviteCode, renameGroup, joinGroupByInvite } from "../core/groups.js";
import { backfillHistory } from "../core/backfill.js";
import {
  listChats, listMessages, searchMessages, searchChats,
  listContacts, searchContacts, getGroupParticipants,
  getMessageCount, getMessageContext, upsertMessage,
  getFilteredMessageCount, getMessage, getMessagesByIds,
} from "../core/store.js";
import { getDb } from "../db/database.js";
import { exportMessages, collectUndownloadedMedia, collectEnrichTargets, buildManifest, writeManifest, quotedSnippet, ENRICH_MANIFEST_MEDIA_TYPES } from "../core/export.js";
import { sshWuExec, syncDb, syncMedia } from "../core/remote.js";
import { MEDIA_DIR } from "../config/paths.js";

const MEDIA_SSH_TIMEOUT_MS = 300_000;

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
  // Download specific media ids by whatever path is available (local socket,
  // a running daemon's socket, or the remote VPS), pulling bytes back locally.
  async function downloadMediaForManifest(
    ids: string[]
  ): Promise<{ results: unknown[]; errors: unknown[] }> {
    const sock = getSock();
    if (sock) return downloadMediaBatch(ids, sock, config);
    if (await daemonIpcAvailable()) {
      return daemonRequest("media.downloadBatch", { msgIds: ids });
    }
    if (remote) {
      const sshResult = await sshWuExec(
        remote.remote,
        ["media", "download-batch", "--ids", ids.join(","), "--json"],
        { timeoutMs: MEDIA_SSH_TIMEOUT_MS }
      );
      if (sshResult.exitCode !== 0) throw new Error(sshResult.stderr);
      try { await syncMedia(remote.remote, MEDIA_DIR); } catch { /* best effort */ }
      return JSON.parse(sshResult.stdout);
    }
    throw new Error("no media download path available");
  }

  // Concurrency for the enrichment pass. Local backends shell out via a
  // blocking call so they run effectively serially regardless; this only
  // parallelises hosted-API backends.
  const ENRICH_CONCURRENCY = 3;

  interface EnrichCapabilitySummary {
    backend: string;
    available: boolean;
    enriched: number;
    skipped: number;
    errors: number;
    detail?: string;
  }

  // Run OCR over the window's images and transcription over its audio, writing
  // the text onto each message (already-enriched items are skipped). A disabled
  // or unconfigured backend is reported, never fatal.
  async function enrichWindow(
    chatJid: string,
    after: number | undefined,
    before: number | undefined
  ): Promise<Record<Capability, EnrichCapabilitySummary>> {
    const summary = {} as Record<Capability, EnrichCapabilitySummary>;

    for (const capability of ["transcribe", "ocr"] as Capability[]) {
      const status = resolveBackend(capability, config.enrich);
      const targets = collectEnrichTargets(chatJid, capability, after, before);

      if (!status.available) {
        summary[capability] = {
          backend: status.backend,
          available: false,
          enriched: 0,
          skipped: targets.length,
          errors: 0,
          detail: `${status.detail}. ${status.enable_hint}`.trim(),
        };
        continue;
      }

      const pool = await asyncPool(targets, ENRICH_CONCURRENCY, (msgId) =>
        enrichMessage(capability, msgId, config)
      );
      summary[capability] = {
        backend: status.backend,
        available: true,
        enriched: pool.filter((r) => r.status === "fulfilled").length,
        skipped: 0,
        errors: pool.filter((r) => r.status === "rejected").length,
      };
    }

    return summary;
  }

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
      if (sock) {
        try {
          const result = await downloadMedia(params.message_id, sock, config, params.out_dir);
          return jsonResult(result);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      }

      // No local socket: route through a running daemon's socket if present.
      if (await daemonIpcAvailable()) {
        try {
          const result = await daemonRequest("media.download", {
            msgId: params.message_id,
            outDir: params.out_dir,
          });
          return jsonResult(result);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      }

      // Remote mode: download on the VPS (its daemon serves it), then pull the
      // bytes back so the file exists locally.
      if (remote) {
        try {
          const args = ["media", "download", params.message_id];
          if (params.out_dir) args.push("--out", params.out_dir);
          args.push("--json");
          const sshResult = await sshWuExec(remote.remote, args, { timeoutMs: MEDIA_SSH_TIMEOUT_MS });
          if (sshResult.exitCode !== 0) {
            return errorResult(`Remote download failed: ${sshResult.stderr}`);
          }
          try { await syncMedia(remote.remote, MEDIA_DIR); } catch { /* best effort */ }
          return jsonResult(JSON.parse(sshResult.stdout));
        } catch (err) {
          return errorResult((err as Error).message);
        }
      }

      return errorResult("Not connected to WhatsApp and no daemon or remote available");
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
      after: z.number().optional().describe("After timestamp (unix) — only return matches newer than this"),
      before: z.number().optional().describe("Before timestamp (unix) — only return matches older than this"),
    },
    async (params) => {
      try {
        const cfg = loadConfig();
        const allResults = searchMessages(params.query, {
          chatJid: params.chat,
          senderJid: params.from,
          limit: 10000,
          after: params.after,
          before: params.before,
        });
        const results = allResults.filter((r) => shouldCollect(r.chat_jid, cfg)).slice(0, params.limit);
        const quotedIds = results.map((r) => r.quoted_id).filter((x): x is string => !!x);
        const quotedMap = getMessagesByIds(quotedIds);
        const snippetFor = (qid: string | null) => {
          if (!qid) return null;
          const q = quotedMap.get(qid);
          return q ? quotedSnippet(q) : null;
        };
        return jsonResult(
          results.map((r) => ({
            id: r.id,
            chat_jid: r.chat_jid,
            sender_name: r.sender_name,
            body: r.body,
            snippet: r.snippet,
            type: r.type,
            timestamp: r.timestamp,
            quoted_id: r.quoted_id,
            quoted_snippet: snippetFor(r.quoted_id),
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
  // In local-daemon and remote modes the WhatsApp session lives in another
  // process, so getSock() is undefined and connection state has to come from
  // that process (via SSH for remote, unobservable for local-daemon).
  server.tool(
    "wu_status",
    "Get WhatsApp connection status. Returns the active mode (local, local-daemon, or remote) and the connection state from whichever process holds the session. In remote mode the remote daemon is SSH'd; the local socket is not what's checked.",
    {},
    async () => {
      const localSock = getSock();
      const messages_stored = getMessageCount();

      if (localSock) {
        return jsonResult({
          mode: "local",
          connected: (localSock.ws as any)?.isOpen ?? false,
          messages_stored,
          timestamp: Date.now(),
        });
      }

      if (remote) {
        try {
          const ssh = await sshWuExec(remote.remote, ["status", "--json"]);
          if (ssh.exitCode === 0) {
            const remoteStatus = JSON.parse(ssh.stdout) as {
              authenticated?: boolean;
              daemon_running?: boolean;
              phone?: string;
              name?: string;
              stream?: unknown;
            };
            // The remote daemon's live stream/ingestion health. `connected`
            // alone only proves the process is up; `stream.stale` or
            // `stream.store_healthy === false` is how a daemon that is "up" but
            // no longer persisting messages shows itself.
            return jsonResult({
              mode: "remote",
              remote_name: remote.name,
              remote_host: remote.remote.host,
              connected: !!remoteStatus.daemon_running,
              authenticated: !!remoteStatus.authenticated,
              remote_phone: remoteStatus.phone,
              remote_name_display: remoteStatus.name,
              stream: remoteStatus.stream ?? null,
              messages_stored,
              note: "Reads served from local synced DB; writes are SSH'd to the remote daemon. messages_stored reflects last sync, not current remote state. Check stream.stale / stream.store_healthy for live ingestion health, not just connected.",
              timestamp: Date.now(),
            });
          }
          return jsonResult({
            mode: "remote",
            remote_name: remote.name,
            remote_host: remote.remote.host,
            connected: false,
            error: `SSH to remote failed: ${ssh.stderr.trim() || "non-zero exit"}`,
            messages_stored,
            timestamp: Date.now(),
          });
        } catch (err) {
          return jsonResult({
            mode: "remote",
            remote_name: remote.name,
            remote_host: remote.remote.host,
            connected: false,
            error: (err as Error).message,
            messages_stored,
            timestamp: Date.now(),
          });
        }
      }

      return jsonResult({
        mode: "local-daemon",
        connected: null,
        note: "A local daemon owns the WhatsApp session; this MCP process is read-only. Run `wu status` directly to see the daemon's connection state.",
        messages_stored,
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
    "List WhatsApp groups with community linkage. Returns all known groups by default so JIDs can be discovered. Pass allowed_only=true to skip groups whose constraint is 'none'. Rows include is_community, is_community_announce, and linked_parent for tree rendering.",
    {
      live: z.boolean().optional().default(false).describe("Fetch live from WhatsApp instead of cache"),
      allowed_only: z.boolean().optional().default(false).describe("Filter to groups whose constraint mode is read or full (skip 'none')"),
      limit: z.number().optional().default(200).describe("Max results"),
    },
    async (params) => {
      const cfg = loadConfig();
      if (params.live) {
        const sock = getSock();
        if (!sock) return errorResult("Not connected to WhatsApp (use live=false for cached, or run from a process holding the local connection)");
        try {
          const groups = await fetchAllGroups(sock);
          const all = Object.values(groups);
          const filtered = params.allowed_only ? all.filter((g: any) => shouldCollect(g.id, cfg)) : all;
          return jsonResult(
            filtered.slice(0, params.limit).map((g: any) => ({
              jid: g.id,
              name: g.subject,
              participant_count: g.participants?.length ?? 0,
              is_community: !!g.isCommunity,
              is_community_announce: !!g.isCommunityAnnounce,
              linked_parent: g.linkedParent || null,
              constraint: resolveConstraint(g.id, cfg),
            }))
          );
        } catch (err) {
          return errorResult((err as Error).message);
        }
      }
      const allChats = listChats({ limit: 10000 });
      let chats = allChats.filter((c) => c.type === "group");
      if (params.allowed_only) chats = chats.filter((c) => shouldCollect(c.jid, cfg));
      chats = chats.slice(0, params.limit);
      return jsonResult(
        chats.map((c) => ({
          jid: c.jid,
          name: c.name,
          participant_count: c.participant_count,
          is_community: c.is_community === 1,
          is_community_announce: c.is_community_announce === 1,
          linked_parent: c.linked_parent,
          last_message_at: c.last_message_at,
          last_seen_at: c.last_seen_at,
          constraint: resolveConstraint(c.jid, cfg),
        }))
      );
    }
  );

  // --- wu_communities_list ---
  server.tool(
    "wu_communities_list",
    "List WhatsApp Communities (parent groups that contain subgroups). Pass with_subgroups=true to include linked children.",
    {
      with_subgroups: z.boolean().optional().default(false).describe("Include linked subgroups under each community"),
      limit: z.number().optional().default(100).describe("Max communities"),
    },
    async (params) => {
      const cfg = loadConfig();
      const allChats = listChats({ limit: 10000 });
      const parents = allChats.filter((c) => c.type === "group" && c.is_community === 1).slice(0, params.limit);

      const childrenByParent = new Map<string, typeof allChats>();
      if (params.with_subgroups) {
        for (const c of allChats) {
          if (c.linked_parent) {
            const list = childrenByParent.get(c.linked_parent) || [];
            list.push(c);
            childrenByParent.set(c.linked_parent, list);
          }
        }
      }

      return jsonResult(
        parents.map((p) => ({
          jid: p.jid,
          name: p.name,
          constraint: resolveConstraint(p.jid, cfg),
          subgroups: params.with_subgroups
            ? (childrenByParent.get(p.jid) || []).map((c) => ({
                jid: c.jid,
                name: c.name,
                is_announce: c.is_community_announce === 1,
                constraint: resolveConstraint(c.jid, cfg),
              }))
            : undefined,
        }))
      );
    }
  );

  // --- wu_dms_list ---
  server.tool(
    "wu_dms_list",
    "List 1:1 (direct message) chats. Constraint-gated by default since DM JIDs contain phone numbers. Pass include_blocked=true to see un-opted-in JIDs.",
    {
      include_blocked: z.boolean().optional().default(false).describe("Include DMs whose constraint resolves to 'none'"),
      limit: z.number().optional().default(100).describe("Max results"),
    },
    async (params) => {
      const cfg = loadConfig();
      const allChats = listChats({ limit: 10000 });
      let dms = allChats.filter((c) => c.type === "dm");
      if (!params.include_blocked) dms = dms.filter((c) => shouldCollect(c.jid, cfg));
      dms = dms.slice(0, params.limit);
      return jsonResult(
        dms.map((c) => ({
          jid: c.jid,
          name: c.name,
          last_message_at: c.last_message_at,
          constraint: resolveConstraint(c.jid, cfg),
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
        const allRows = [result.target, ...result.before, ...result.after];
        const quotedIds = allRows.map((m) => m.quoted_id).filter((x): x is string => !!x);
        const quotedMap = getMessagesByIds(quotedIds);
        const snippetFor = (qid: string | null) => {
          if (!qid) return null;
          const q = quotedMap.get(qid);
          return q ? quotedSnippet(q) : null;
        };
        const fmt = (m: any) => ({
          id: m.id,
          sender: m.sender_jid,
          sender_name: m.sender_name,
          body: m.body,
          type: m.type,
          timestamp: m.timestamp,
          quoted_id: m.quoted_id,
          quoted_snippet: snippetFor(m.quoted_id),
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

  // --- wu_messages_count ---
  server.tool(
    "wu_messages_count",
    "Get the count of messages matching filters (lightweight, no message data returned). Useful for planning pagination or checking volume before export.",
    {
      chat: z.string().optional().describe("Filter by chat JID"),
      after: z.number().optional().describe("After timestamp (unix)"),
      before: z.number().optional().describe("Before timestamp (unix)"),
    },
    async (params) => {
      try {
        const count = getFilteredMessageCount({
          chatJid: params.chat,
          after: params.after,
          before: params.before,
        });
        return jsonResult({ count });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }
  );

  // --- wu_messages_export ---
  server.tool(
    "wu_messages_export",
    "Export messages from a chat to a file on disk. Handles pagination internally — no message limit. Returns a summary (count, file path, size) instead of message data, keeping the LLM context window clean.",
    {
      chat: z.string().describe("Chat JID"),
      after: z.number().optional().describe("After timestamp (unix)"),
      before: z.number().optional().describe("Before timestamp (unix)"),
      format: z.enum(["jsonl", "json", "markdown", "csv"]).optional().default("jsonl").describe("Output format"),
      output: z.string().describe("File path to write to"),
      exclude_reactions: z.boolean().optional().default(false).describe("Skip reaction messages"),
      types: z.array(z.string()).optional().describe("Only export these message types (e.g. text, image, document)"),
      exclude_types: z.array(z.string()).optional().describe("Skip these message types (e.g. sticker, reaction)"),
      download_media: z.boolean().optional().default(false).describe("Also download image+document media in the window and write a <output>.manifest.jsonl of {msgId,type,sender,timestamp,caption,local_path,ocr_text,transcript} so each can be opened directly"),
      enrich: z.boolean().optional().default(false).describe("In the same pass, OCR images and transcribe audio (also downloads audio), writing the text onto each message and into the manifest. Implies download_media. Uses the configured enrich backends (see wu_enrich_status); a disabled backend is skipped, not fatal."),
    },
    async (params) => {
      const cfg = loadConfig();
      if (!shouldCollect(params.chat, cfg)) {
        return errorResult(`Chat ${params.chat} is blocked by constraints`);
      }
      try {
        const result = exportMessages({
          chatJid: params.chat,
          after: params.after,
          before: params.before,
          format: params.format,
          output: params.output,
          excludeReactions: params.exclude_reactions,
          types: params.types,
          excludeTypes: params.exclude_types,
        });

        if (!params.download_media && !params.enrich) return jsonResult(result);

        // Download the window's media. Images + documents always; audio too when
        // enriching, since transcription needs the bytes locally.
        const ids = collectUndownloadedMedia(params.chat, params.after, params.before);
        if (params.enrich) {
          ids.push(...collectUndownloadedMedia(params.chat, params.after, params.before, ["audio"]));
        }
        let mediaDownloaded = 0;
        let mediaErrors = 0;
        if (ids.length > 0) {
          try {
            const dl = await downloadMediaForManifest(ids);
            mediaDownloaded = dl.results.length;
            mediaErrors = dl.errors.length;
          } catch (err) {
            return errorResult(`Export wrote ${result.file}, but media download failed: ${(err as Error).message}`);
          }
        }

        // Enrich (OCR/transcribe) after the bytes are local.
        const enrichment = params.enrich
          ? await enrichWindow(params.chat, params.after, params.before)
          : undefined;

        const manifestTypes = params.enrich ? ENRICH_MANIFEST_MEDIA_TYPES : undefined;
        const rows = buildManifest(params.chat, params.after, params.before, MEDIA_DIR, manifestTypes);
        const manifestFile = `${params.output}.manifest.jsonl`;
        writeManifest(manifestFile, rows);

        return jsonResult({
          ...result,
          manifest_file: manifestFile,
          manifest_rows: rows.length,
          manifest_resolved: rows.filter((r) => r.local_path).length,
          media_downloaded: mediaDownloaded,
          media_errors: mediaErrors,
          ...(enrichment ? { enrichment } : {}),
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
      delete_remote_after: z.boolean().optional().default(false).describe("In remote mode, delete the files on the VPS after pulling them back (saves disk on the box)"),
    },
    async (params) => {
      const sock = getSock();
      if (!sock) {
        // Route through a local daemon's socket when one is running (it resolves
        // the chat's undownloaded media itself when no ids are given).
        if (await daemonIpcAvailable()) {
          try {
            const result = await daemonRequest("media.downloadBatch", {
              msgIds: params.message_ids,
              chat: params.chat,
              limit: params.limit,
              concurrency: params.concurrency,
            });
            return jsonResult(result);
          } catch (err) {
            return errorResult((err as Error).message);
          }
        }

        if (remote) {
          try {
            const args = ["media", "download-batch"];
            if (params.chat) args.push(params.chat);
            if (params.limit) args.push("--limit", String(params.limit));
            if (params.concurrency) args.push("--concurrency", String(params.concurrency));
            args.push("--json");

            // Cold login + a batch can run long; give it room, and pull the
            // downloaded files back to the local media dir afterwards.
            const sshResult = await sshWuExec(remote.remote, args, { timeoutMs: MEDIA_SSH_TIMEOUT_MS });
            if (sshResult.exitCode !== 0) {
              return errorResult(`Remote batch download failed: ${sshResult.stderr}`);
            }
            try { await syncMedia(remote.remote, MEDIA_DIR); } catch { /* best effort */ }
            if (params.delete_remote_after && params.chat) {
              // Bytes are now local; reclaim the VPS copy.
              try { await sshWuExec(remote.remote, ["media", "prune", "--chat", params.chat], { timeoutMs: MEDIA_SSH_TIMEOUT_MS }); } catch { /* best effort */ }
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

  // --- wu_media_prune ---
  server.tool(
    "wu_media_prune",
    "Delete downloaded media files to reclaim disk (exports/DB are the durable record). In remote mode, prunes on the VPS.",
    {
      older_than: z.string().optional().describe("Only prune media older than this (e.g. 30d, 12h, 2w)"),
      chat: z.string().optional().describe("Limit to one chat JID"),
      dry_run: z.boolean().optional().default(false).describe("Report what would be freed without deleting"),
    },
    async (params) => {
      // Media lives wherever the daemon runs: locally if we own the socket,
      // otherwise on the VPS in remote mode.
      if (remote && !getSock()) {
        try {
          const args = ["media", "prune"];
          if (params.older_than) args.push("--older-than", params.older_than);
          if (params.chat) args.push("--chat", params.chat);
          if (params.dry_run) args.push("--dry-run");
          args.push("--json");
          const sshResult = await sshWuExec(remote.remote, args, { timeoutMs: MEDIA_SSH_TIMEOUT_MS });
          if (sshResult.exitCode !== 0) return errorResult(`Remote prune failed: ${sshResult.stderr}`);
          return jsonResult(JSON.parse(sshResult.stdout));
        } catch (err) {
          return errorResult((err as Error).message);
        }
      }

      let olderThanSec: number | undefined;
      if (params.older_than) {
        const parsed = parseDuration(params.older_than);
        if (parsed === null) return errorResult(`Invalid duration: ${params.older_than} (try 30d, 12h, 2w)`);
        olderThanSec = parsed;
      }
      try {
        return jsonResult(pruneMedia({ olderThanSec, chatJid: params.chat, dryRun: params.dry_run }));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }
  );

  // --- wu_enrich_status ---
  server.tool(
    "wu_enrich_status",
    "Show which media-enrichment backends (transcription, OCR) are configured and ready, with exact steps to enable any that are off. Check this before transcribe/OCR.",
    {},
    async () => {
      return jsonResult({ backends: enrichStatus(config.enrich) });
    }
  );

  // --- wu_media_transcribe ---
  server.tool(
    "wu_media_transcribe",
    "Transcribe a voice/audio message to text (stored on the message and made searchable). Downloads the audio first if needed. Requires a configured transcribe backend — see wu_enrich_status.",
    {
      message_id: z.string().describe("ID of an audio/voice message"),
    },
    async (params) => {
      try {
        // Make sure the audio is on this machine (transcription runs here).
        const row = getMessage(params.message_id);
        if (row && !resolveLocalMediaPath(row)) {
          try { await downloadMediaForManifest([params.message_id]); } catch { /* enrichMessage will report a clear error */ }
        }
        const result = await enrichMessage("transcribe", params.message_id, config);
        return jsonResult(result);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }
  );

  // --- wu_media_ocr ---
  server.tool(
    "wu_media_ocr",
    "Extract text from an image message (stored on the message and made searchable). Downloads the image first if needed. Requires a configured ocr backend — see wu_enrich_status.",
    {
      message_id: z.string().describe("ID of an image message"),
    },
    async (params) => {
      try {
        const row = getMessage(params.message_id);
        if (row && !resolveLocalMediaPath(row)) {
          try { await downloadMediaForManifest([params.message_id]); } catch { /* enrichMessage will report a clear error */ }
        }
        const result = await enrichMessage("ocr", params.message_id, config);
        return jsonResult(result);
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
