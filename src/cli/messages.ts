import { Command } from "commander";
import { withConnection } from "../core/connection.js";
import { sendText, sendMedia, sendReaction, sendPoll, deleteForEveryone } from "../core/sender.js";
import { listMessages, searchMessages } from "../core/store.js";
import { loadConfig } from "../config/schema.js";
import { outputResult, formatTimestamp } from "./format.js";
import { EXIT_NOT_FOUND, EXIT_GENERAL_ERROR } from "./exit-codes.js";

export function registerMessagesCommand(program: Command): void {
  const messages = program
    .command("messages")
    .description("List, search, send, react, and delete messages");

  messages
    .command("list <jid>")
    .description("List messages in a chat")
    .option("--limit <n>", "Max messages to show", "50")
    .option("--before <ts>", "Before timestamp (unix)")
    .option("--after <ts>", "After timestamp (unix)")
    .option("--json", "Output as JSON")
    .action(
      (
        jid: string,
        opts: { limit: string; before?: string; after?: string; json?: boolean }
      ) => {
        const rows = listMessages({
          chatJid: jid,
          limit: parseInt(opts.limit, 10),
          before: opts.before ? parseInt(opts.before, 10) : undefined,
          after: opts.after ? parseInt(opts.after, 10) : undefined,
        });

        if (rows.length === 0) {
          console.log("No messages found.");
          return;
        }

        if (opts.json) {
          outputResult(rows, { json: true });
        } else {
          for (const row of rows.reverse()) {
            const ts = formatTimestamp(row.timestamp);
            const sender = row.sender_name || row.sender_jid || "me";
            const body = row.body || `<${row.type}>`;
            console.log(`[${ts}] ${sender}: ${body}`);
          }
        }
      }
    );

  messages
    .command("search <query>")
    .description("Search messages by text content")
    .option("--chat <jid>", "Filter by chat JID")
    .option("--from <jid>", "Filter by sender JID")
    .option("--limit <n>", "Max results", "50")
    .option("--json", "Output as JSON")
    .action(
      (
        query: string,
        opts: { chat?: string; from?: string; limit: string; json?: boolean }
      ) => {
        const rows = searchMessages(query, {
          chatJid: opts.chat,
          senderJid: opts.from,
          limit: parseInt(opts.limit, 10),
        });

        if (rows.length === 0) {
          console.log("No messages found.");
          return;
        }

        if (opts.json) {
          outputResult(rows, { json: true });
        } else {
          for (const row of rows) {
            const ts = formatTimestamp(row.timestamp);
            const sender = row.sender_name || row.sender_jid || "me";
            console.log(`[${ts}] [${row.chat_jid}] ${sender}: ${row.body}`);
          }
        }
      }
    );

  messages
    .command("send <jid> [text]")
    .description("Send a text message, media, or poll")
    .option("--media <path>", "Send media file")
    .option("--caption <text>", "Caption for media")
    .option("--reply-to <id>", "Reply to a specific message ID")
    .option("--poll <question>", "Create a poll")
    .option("--options <list>", "Comma-separated poll options")
    .option("--json", "Output as JSON")
    .action(
      async (
        jid: string,
        text: string | undefined,
        opts: {
          media?: string;
          caption?: string;
          replyTo?: string;
          poll?: string;
          options?: string;
          json?: boolean;
        }
      ) => {
        const config = loadConfig();

        try {
          await withConnection(async (sock) => {
            let result;

            if (opts.poll) {
              const pollOptions = (opts.options || "")
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
              if (pollOptions.length < 2) {
                console.error("Polls require at least 2 options");
                process.exit(EXIT_GENERAL_ERROR);
              }
              result = await sendPoll(sock, jid, opts.poll, pollOptions, config);
            } else if (opts.media) {
              result = await sendMedia(sock, jid, opts.media, config, {
                caption: opts.caption || text,
                replyTo: opts.replyTo,
              });
            } else if (text) {
              result = await sendText(sock, jid, text, config, {
                replyTo: opts.replyTo,
              });
            } else {
              console.error("Provide text, --media, or --poll");
              process.exit(EXIT_GENERAL_ERROR);
            }

            if (opts.json) {
              console.log(
                JSON.stringify({
                  id: result?.key?.id,
                  timestamp: result?.messageTimestamp,
                })
              );
            } else {
              console.log(`Sent: ${result?.key?.id}`);
            }
          });
        } catch (err) {
          const error = err as Error & { exitCode?: number };
          console.error(error.message);
          process.exit(error.exitCode || EXIT_GENERAL_ERROR);
        }
      }
    );

  messages
    .command("react <jid> <msg-id> <emoji>")
    .description("React to a message (empty string to remove)")
    .action(async (jid: string, msgId: string, emoji: string) => {
      const config = loadConfig();
      try {
        await withConnection(async (sock) => {
          await sendReaction(sock, jid, msgId, emoji, config);
          console.log(emoji ? `Reacted with ${emoji}` : "Reaction removed");
        });
      } catch (err) {
        const error = err as Error & { exitCode?: number };
        console.error(error.message);
        process.exit(error.exitCode || EXIT_GENERAL_ERROR);
      }
    });

  messages
    .command("delete <jid> <msg-id>")
    .description("Delete a message for everyone")
    .action(async (jid: string, msgId: string) => {
      const config = loadConfig();
      try {
        await withConnection(async (sock) => {
          await deleteForEveryone(sock, jid, msgId, config);
          console.log(`Deleted: ${msgId}`);
        });
      } catch (err) {
        const error = err as Error & { exitCode?: number };
        console.error(error.message);
        process.exit(error.exitCode || EXIT_GENERAL_ERROR);
      }
    });
}
