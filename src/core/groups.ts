import type { WASocket } from "@whiskeysockets/baileys";
import type { WuConfig } from "../config/schema.js";
import { assertCanManage, shouldCollect } from "./constraints.js";
import { upsertChat, upsertGroupParticipants } from "./store.js";
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

/**
 * Pull every participating group off `sock` and write the full public header
 * (name, participant count, community flags, linked parent) plus - for chats the
 * constraints allow - the description and roster.
 *
 * This is the repair path for a store whose group metadata is missing: message
 * and chat events only ever carry a name, and the upsert coalesces nulls to keep
 * partial writes from wiping good data, so a row first created by an arriving
 * message keeps null metadata until a full fetch like this one fills it in.
 * Shared by the CLI and the daemon so a refresh can run on whichever socket is
 * already open instead of a second login.
 */
export async function refreshGroupMetadata(
  sock: WASocket,
  config: WuConfig
): Promise<{ groups: number; rosters: number }> {
  const allGroups = await fetchAllGroups(sock);
  const now = Math.floor(Date.now() / 1000);
  const discoveryOn = config.whatsapp.group_discovery;
  let groups = 0;
  let rosters = 0;

  for (const g of Object.values(allGroups)) {
    const allowed = shouldCollect(g.id, config);
    if (!discoveryOn && !allowed) continue;
    upsertChat({
      jid: g.id,
      name: g.subject || null,
      type: "group",
      participant_count: g.participants?.length || null,
      description: allowed ? g.desc || null : null,
      last_message_at: null,
      last_seen_at: now,
      is_community: (g as { isCommunity?: boolean }).isCommunity ? 1 : 0,
      is_community_announce: (g as { isCommunityAnnounce?: boolean }).isCommunityAnnounce ? 1 : 0,
      linked_parent: (g as { linkedParent?: string }).linkedParent || null,
    });
    groups++;

    // Length-checked: the roster write replaces what is stored, so an empty
    // list would delete a good one.
    if (g.participants?.length && allowed) {
      upsertGroupParticipants(
        g.id,
        g.participants.map((p) => ({
          jid: p.id,
          isAdmin: p.admin === "admin" || p.admin === "superadmin",
          isSuperAdmin: p.admin === "superadmin",
        }))
      );
      rosters++;
    }
  }

  logger.debug({ groups, rosters }, "Refreshed group metadata");
  return { groups, rosters };
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

export async function renameGroup(
  sock: WASocket,
  jid: string,
  newName: string,
  config: WuConfig
): Promise<void> {
  assertCanManage(jid, config);
  logger.debug({ jid, newName }, "Renaming group");
  await sock.groupUpdateSubject(jid, newName);
  upsertChat({
    jid,
    name: newName,
    type: "group",
    participant_count: null,
    description: null,
    last_message_at: null,
  });
}

export async function joinGroupByInvite(
  sock: WASocket,
  codeOrUrl: string
): Promise<string | undefined> {
  const code = codeOrUrl.includes("chat.whatsapp.com/")
    ? codeOrUrl.split("chat.whatsapp.com/").pop()!
    : codeOrUrl;
  logger.debug({ code }, "Joining group by invite");
  return sock.groupAcceptInvite(code);
}
