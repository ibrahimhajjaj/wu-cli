import type { WASocket } from "@whiskeysockets/baileys";
import type { WuConfig } from "../config/schema.js";
import { assertCanManage } from "./constraints.js";
import { createChildLogger } from "../config/logger.js";

const logger = createChildLogger("groups");

export async function fetchGroupMetadata(sock: WASocket, jid: string) {
  logger.debug({ jid }, "Fetching group metadata");
  return sock.groupMetadata(jid);
}

export async function fetchAllGroups(sock: WASocket) {
  logger.debug("Fetching all participating groups");
  return sock.groupFetchAllParticipating();
}

export async function createGroup(
  sock: WASocket,
  name: string,
  participants: string[],
  config: WuConfig
) {
  // No specific JID to check — use default constraint
  logger.debug({ name, participants }, "Creating group");
  return sock.groupCreate(name, participants);
}

export async function getInviteCode(
  sock: WASocket,
  jid: string,
  config: WuConfig
): Promise<string> {
  assertCanManage(jid, config);
  logger.debug({ jid }, "Getting invite code");
  return sock.groupInviteCode(jid) as Promise<string>;
}

export async function leaveGroup(
  sock: WASocket,
  jid: string,
  config: WuConfig
): Promise<void> {
  assertCanManage(jid, config);
  logger.debug({ jid }, "Leaving group");
  await sock.groupLeave(jid);
}
