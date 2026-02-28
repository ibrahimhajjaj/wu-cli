import { Command } from "commander";
import { withConnection as _withConnection } from "../core/connection.js";
import {
  fetchGroupMetadata,
  fetchAllGroups,
  createGroup,
  getInviteCode,
  leaveGroup,
} from "../core/groups.js";
import {
  listChats,
  getGroupParticipants,
  upsertChat,
  upsertGroupParticipants,
} from "../core/store.js";
import { loadConfig } from "../config/schema.js";
import { shouldCollect } from "../core/constraints.js";
import { outputResult } from "./format.js";
import { EXIT_GENERAL_ERROR, EXIT_NOT_FOUND } from "./exit-codes.js";

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
    .description("List all groups")
    .option("--limit <n>", "Max groups to show", "100")
    .option("--live", "Fetch live from WhatsApp (connects to server)")
    .option("--json", "Output as JSON")
    .action(async (opts: { limit: string; live?: boolean; json?: boolean }) => {
      const limit = parseInt(opts.limit, 10);

      const config = loadConfig();

      if (opts.live) {
        // Live fetch from WhatsApp
        try {
          await withConnection(async (sock) => {
            const allGroups = await fetchAllGroups(sock);
            const entries = Object.values(allGroups)
              .filter((g: any) => shouldCollect(g.id, config))
              .slice(0, limit);

            if (entries.length === 0) {
              console.log("No groups found (matching constraints).");
              return;
            }

            // Store in DB for future cached access
            for (const g of entries) {
              upsertChat({
                jid: g.id,
                name: g.subject || null,
                type: "group",
                participant_count: g.participants?.length || null,
                description: g.desc || null,
                last_message_at: null,
              });
              if (g.participants) {
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

            if (opts.json) {
              outputResult(
                entries.map((g) => ({
                  jid: g.id,
                  name: g.subject,
                  participant_count: g.participants?.length || 0,
                })),
                { json: true }
              );
            } else {
              for (const g of entries) {
                const count = g.participants ? ` (${g.participants.length})` : "";
                console.log(`${g.subject || g.id}${count}  ${g.id}`);
              }
            }
          });
        } catch (err) {
          console.error("Failed to fetch groups:", (err as Error).message);
          process.exit(EXIT_GENERAL_ERROR);
        }
        return;
      }

      // Default: cached from DB
      const allChats = listChats({ limit: 10000 });
      const groupChats = allChats
        .filter((c) => c.type === "group" && shouldCollect(c.jid, config))
        .slice(0, limit);

      if (groupChats.length === 0) {
        console.log(
          "No groups cached. Run `wu groups list --live` to fetch from WhatsApp."
        );
        return;
      }

      if (opts.json) {
        outputResult(groupChats, { json: true });
      } else {
        for (const g of groupChats) {
          const name = g.name || g.jid;
          const count = g.participant_count ? ` (${g.participant_count})` : "";
          console.log(`${name}${count}  ${g.jid}`);
        }
      }
    });

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
      const allChats = listChats({ limit: 10000 });
      const chat = allChats.find((c) => c.jid === jid);
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
    .action(async (name: string, participants: string[]) => {
      const config = loadConfig();
      try {
        await withConnection(async (sock) => {
          const result = await createGroup(sock, name, participants, config);
          console.log(`Group created: ${result.id}`);
          console.log(`Name: ${result.subject}`);
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
}
