import type { WASocket } from "@whiskeysockets/baileys";
import { isAbsolute, resolve } from "path";
import type { WuConfig } from "../config/schema.js";
import { sendText, sendMedia, sendReaction, sendPoll, deleteForEveryone } from "./sender.js";
import { createGroup, getInviteCode, leaveGroup, renameGroup, joinGroupByInvite } from "./groups.js";

// Every write that needs the live socket, in one shape: plain JSON params in,
// plain JSON out. The daemon serves these over IPC and a one-shot login runs
// the same functions, so a CLI command, an MCP tool and the daemon cannot drift
// apart on validation or on what they report back.

export interface SendParams {
  to: string;
  text?: string;
  media?: string;
  caption?: string;
  replyTo?: string;
  poll?: string;
  options?: string[];
}

export interface SendResult {
  id: string | null;
  timestamp: number | null;
}

// messageTimestamp is a protobuf Long on some paths; JSON would turn it into
// an object, so flatten it before it crosses the socket.
function toUnix(ts: unknown): number | null {
  if (ts == null) return null;
  const n = Number(ts);
  return Number.isFinite(n) ? n : null;
}

export async function sendAction(sock: WASocket, config: WuConfig, p: SendParams): Promise<SendResult> {
  let sent;
  if (p.poll) {
    const options = (p.options ?? []).map((s) => s.trim()).filter(Boolean);
    if (options.length < 2) throw new Error("Polls require at least 2 options");
    sent = await sendPoll(sock, p.to, p.poll, options, config);
  } else if (p.media) {
    sent = await sendMedia(sock, p.to, p.media, config, {
      caption: p.caption || p.text,
      replyTo: p.replyTo,
    });
  } else if (p.text) {
    sent = await sendText(sock, p.to, p.text, config, { replyTo: p.replyTo });
  } else {
    throw new Error("Provide text, media, or a poll");
  }
  return { id: sent?.key?.id ?? null, timestamp: toUnix(sent?.messageTimestamp) };
}

// The daemon reads the file itself, from its own working directory, so a
// relative path has to be pinned to the caller's before it is handed over.
export function absoluteMediaPath(path: string | undefined): string | undefined {
  if (!path) return path;
  return isAbsolute(path) ? path : resolve(path);
}

export const actions = {
  "messages.send": (sock: WASocket, config: WuConfig, p: Record<string, unknown>) =>
    sendAction(sock, config, p as unknown as SendParams),

  "messages.react": async (sock: WASocket, config: WuConfig, p: Record<string, unknown>) => {
    await sendReaction(sock, String(p.jid), String(p.msgId), String(p.emoji ?? ""), config);
    return { success: true };
  },

  "messages.delete": async (sock: WASocket, config: WuConfig, p: Record<string, unknown>) => {
    const fromMe = typeof p.fromMe === "boolean" ? p.fromMe : undefined;
    const sent = await deleteForEveryone(sock, String(p.jid), String(p.msgId), config, { fromMe });
    return { id: String(p.msgId), revoke_id: sent?.key?.id ?? null };
  },

  "groups.create": async (sock: WASocket, config: WuConfig, p: Record<string, unknown>) => {
    const participants = (p.participants as string[] | undefined) ?? [];
    const result = await createGroup(sock, String(p.name), participants, config);
    return {
      id: result.id,
      name: result.subject,
      participant_count: result.participants?.length ?? participants.length,
    };
  },

  "groups.invite": async (sock: WASocket, config: WuConfig, p: Record<string, unknown>) => {
    const code = await getInviteCode(sock, String(p.jid), config);
    return { link: `https://chat.whatsapp.com/${code}` };
  },

  "groups.leave": async (sock: WASocket, config: WuConfig, p: Record<string, unknown>) => {
    await leaveGroup(sock, String(p.jid), config);
    return { success: true, jid: String(p.jid) };
  },

  "groups.rename": async (sock: WASocket, config: WuConfig, p: Record<string, unknown>) => {
    await renameGroup(sock, String(p.jid), String(p.name), config);
    return { success: true, jid: String(p.jid), name: String(p.name) };
  },

  "groups.join": async (sock: WASocket, _config: WuConfig, p: Record<string, unknown>) => {
    const jid = await joinGroupByInvite(sock, String(p.code));
    return { success: true, jid: jid ?? null };
  },
} as const;

export type ActionName = keyof typeof actions;

export function isAction(method: string): method is ActionName {
  return Object.prototype.hasOwnProperty.call(actions, method);
}
