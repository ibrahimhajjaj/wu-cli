import { Command } from "commander";
import { withConnection as _withConnection } from "../core/connection.js";
import {
  fetchGroupMetadata,
  fetchAllGroups,
  createGroup,
  getInviteCode,
  leaveGroup,
  renameGroup,
  joinGroupByInvite,
} from "../core/groups.js";
import {
  getGroupParticipants,
  upsertChat,
  upsertGroupParticipants,
  type ChatRow,
} from "../core/store.js";
import { listGroupsForConfig, getChat } from "../core/service.js";
import { loadConfig } from "../config/schema.js";
import { resolveConstraint, shouldCollect } from "../core/constraints.js";
import type { WuConfig, ConstraintMode } from "../config/schema.js";
import { outputResult } from "./format.js";
import { EXIT_GENERAL_ERROR, EXIT_NOT_FOUND } from "./exit-codes.js";

function statusLabel(mode: ConstraintMode): string {
  switch (mode) {
    case "full":
      return "allowed";
    case "read":
      return "read";
    case "none":
      return "-";
  }
}

function renderGroupTree(groups: ChatRow[], config: WuConfig): string[] {
  const byParent = new Map<string, ChatRow[]>();
  const communities = new Map<string, ChatRow>();
  const orphans: ChatRow[] = [];

  for (const g of groups) {
    if (g.is_community === 1) {
      communities.set(g.jid, g);
    }
  }
  for (const g of groups) {
    if (g.is_community === 1) continue;
    if (g.linked_parent && communities.has(g.linked_parent)) {
      const list = byParent.get(g.linked_parent) || [];
      list.push(g);
      byParent.set(g.linked_parent, list);
    } else {
      orphans.push(g);
    }
  }

  const lines: string[] = [];
  const fmtRow = (g: ChatRow, indent: string, tag: string) => {
    const status = statusLabel(resolveConstraint(g.jid, config));
    const name = g.name || g.jid;
    const count = g.participant_count ? ` (${g.participant_count})` : "";
    return `${indent}${name}${count}  [${tag}] [${status}]  ${g.jid}`;
  };

  for (const community of communities.values()) {
    lines.push(fmtRow(community, "", "community"));
    const children = byParent.get(community.jid) || [];
    for (const child of children) {
      const tag = child.is_community_announce === 1 ? "announce" : "subgroup";
      lines.push(fmtRow(child, "  └─ ", tag));
    }
  }
  for (const g of orphans) {
    lines.push(fmtRow(g, "", "group"));
  }
  return lines;
}

/** All group CLI commands use quiet connections (no pino noise) */
function withConnection<T>(fn: (sock: import("@whiskeysockets/baileys").WASocket) => Promise<T>) {
  return _withConnection(fn, { quiet: true });
}

export function registerGroupsCommand(program: Command): void {
  const groups = program
    .command("groups")
    .description("List, info, create, invite, leave groups");

  groups
    .command("list")
    .description("List all groups (always shows JID + name; constraints only gate messages)")
    .option("--limit <n>", "Max groups to show", "200")
    .option("--allowed-only", "Show only groups whose constraint is read or full")
    .option("--live", "Fetch live from WhatsApp (connects to server)")
    .option("--json", "Output as JSON")
    .action(
      async (opts: {
        limit: string;
        allowedOnly?: boolean;
        live?: boolean;
        json?: boolean;
      }) => {
        const limit = parseInt(opts.limit, 10);
        const config = loadConfig();

        if (opts.live) {
          try {
            await withConnection(async (sock) => {
              const allGroups = await fetchAllGroups(sock);
              const now = Math.floor(Date.now() / 1000);

              const discoveryOn = config.whatsapp.group_discovery;
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
                  is_community: (g as any).isCommunity ? 1 : 0,
                  is_community_announce: (g as any).isCommunityAnnounce ? 1 : 0,
                  linked_parent: (g as any).linkedParent || null,
                });
                if (g.participants && allowed) {
                  upsertGroupParticipants(
                    g.id,
                    g.participants.map((p) => ({
                      jid: p.id,
                      isAdmin: p.admin === "admin" || p.admin === "superadmin",
                      isSuperAdmin: p.admin === "superadmin",
                    }))
                  );
                }
              }
            });
          } catch (err) {
            console.error("Failed to fetch groups:", (err as Error).message);
            process.exit(EXIT_GENERAL_ERROR);
          }
        }

        const groupChats = listGroupsForConfig(config, {
          limit,
          allowedOnly: opts.allowedOnly,
        });

        if (groupChats.length === 0) {
          console.log(
            "No groups cached. Run `wu groups list --live` once to fetch from WhatsApp, " +
              "or start `wu daemon` to populate as events arrive."
          );
          return;
        }

        if (opts.json) {
          outputResult(
            groupChats.map((g) => ({
              jid: g.jid,
              name: g.name,
              participant_count: g.participant_count,
              is_community: g.is_community === 1,
              is_community_announce: g.is_community_announce === 1,
              linked_parent: g.linked_parent,
              constraint: resolveConstraint(g.jid, config),
              last_seen_at: g.last_seen_at,
            })),
            { json: true }
          );
        } else {
          for (const line of renderGroupTree(groupChats, config)) {
            console.log(line);
          }
        }
      }
    );

  groups
    .command("info <jid>")
    .description("Show group details and participants")
    .option("--json", "Output as JSON")
    .option("--live", "Fetch live from WhatsApp")
    .action(async (jid: string, opts: { json?: boolean; live?: boolean }) => {
      const config = loadConfig();
      if (!shouldCollect(jid, config)) {
        console.error(`Group ${jid} is blocked by constraints. Use \`wu config allow ${jid}\` to allow it.`);
        process.exit(EXIT_GENERAL_ERROR);
      }

      if (opts.live) {
        try {
          await withConnection(async (sock) => {
            const meta = await fetchGroupMetadata(sock, jid);
            const info = {
              jid: meta.id,
              name: meta.subject,
              description: meta.desc,
              participant_count: meta.participants.length,
              participants: meta.participants.map((p) => ({
                jid: p.id,
                admin: p.admin || null,
              })),
            };
            outputResult(info, { json: opts.json });
          });
        } catch (err) {
          console.error((err as Error).message);
          process.exit(EXIT_GENERAL_ERROR);
        }
        return;
      }

      // Default: cached
      const chat = getChat(jid);
      if (!chat) {
        console.error(
          `Group not found in cache: ${jid}\nRun \`wu groups info ${jid} --live\` to fetch from WhatsApp.`
        );
        process.exit(EXIT_NOT_FOUND);
      }
      const participants = getGroupParticipants(jid);
      outputResult(
        { ...chat, participants },
        { json: opts.json }
      );
    });

  groups
    .command("create <name> [participants...]")
    .description("Create a new group")
    .option("--json", "Output as JSON")
    .action(async (name: string, participants: string[], opts: { json?: boolean }) => {
      const config = loadConfig();
      try {
        await withConnection(async (sock) => {
          const result = await createGroup(sock, name, participants, config);
          if (opts.json) {
            outputResult(
              {
                id: result.id,
                name: result.subject,
                participant_count: result.participants?.length ?? participants.length,
              },
              { json: true }
            );
          } else {
            console.log(`Group created: ${result.id}`);
            console.log(`Name: ${result.subject}`);
          }
        });
      } catch (err) {
        console.error((err as Error).message);
        process.exit(EXIT_GENERAL_ERROR);
      }
    });

  groups
    .command("invite <jid>")
    .description("Get group invite link")
    .action(async (jid: string) => {
      const config = loadConfig();
      try {
        await withConnection(async (sock) => {
          const code = await getInviteCode(sock, jid, config);
          console.log(`https://chat.whatsapp.com/${code}`);
        });
      } catch (err) {
        const error = err as Error & { exitCode?: number };
        console.error(error.message);
        process.exit(error.exitCode || EXIT_GENERAL_ERROR);
      }
    });

  groups
    .command("leave <jid>")
    .description("Leave a group")
    .action(async (jid: string) => {
      const config = loadConfig();
      try {
        await withConnection(async (sock) => {
          await leaveGroup(sock, jid, config);
          console.log(`Left group: ${jid}`);
        });
      } catch (err) {
        const error = err as Error & { exitCode?: number };
        console.error(error.message);
        process.exit(error.exitCode || EXIT_GENERAL_ERROR);
      }
    });

  groups
    .command("participants <jid>")
    .description("List group participants (from cache)")
    .option("--json", "Output as JSON")
    .action((jid: string, opts: { json?: boolean }) => {
      const config = loadConfig();
      if (!shouldCollect(jid, config)) {
        console.error(`Group ${jid} is blocked by constraints. Use \`wu config allow ${jid}\` to allow it.`);
        process.exit(EXIT_GENERAL_ERROR);
      }
      const participants = getGroupParticipants(jid);
      if (participants.length === 0) {
        console.log(
          "No participants cached. Run `wu groups list --live` to fetch, or `wu groups info <jid> --live` for details."
        );
        return;
      }
      outputResult(participants, { json: opts.json });
    });

  groups
    .command("rename <jid> <name>")
    .description("Rename a group")
    .action(async (jid: string, name: string) => {
      const config = loadConfig();
      try {
        await withConnection(async (sock) => {
          await renameGroup(sock, jid, name, config);
          console.log(`Renamed group ${jid} to: ${name}`);
        });
      } catch (err) {
        const error = err as Error & { exitCode?: number };
        console.error(error.message);
        process.exit(error.exitCode || EXIT_GENERAL_ERROR);
      }
    });

  groups
    .command("join <code-or-url>")
    .description("Join a group by invite code or URL")
    .action(async (codeOrUrl: string) => {
      try {
        await withConnection(async (sock) => {
          const jid = await joinGroupByInvite(sock, codeOrUrl);
          console.log(`Joined group: ${jid || "(unknown JID)"}`);
        });
      } catch (err) {
        console.error((err as Error).message);
        process.exit(EXIT_GENERAL_ERROR);
      }
    });
}
