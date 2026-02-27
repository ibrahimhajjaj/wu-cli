import { Command } from "commander";
import { createConnection, waitForConnection } from "../core/connection.js";
import { startListener, type ParsedMessage } from "../core/listener.js";
import { acquireLock, releaseLock } from "../core/lock.js";
import { loadConfig } from "../config/schema.js";
import { closeDb } from "../db/database.js";
import { formatTimestamp } from "./format.js";
import { EXIT_CONNECTION_FAILED } from "./exit-codes.js";

export function registerListenCommand(program: Command): void {
  program
    .command("listen")
    .description("Stream incoming messages to stdout")
    .option("--chats <jids>", "Comma-separated JIDs to filter")
    .option("--json", "Force JSON output (auto-detected when piped)")
    .action(async (opts: { chats?: string; json?: boolean }) => {
      const useJson = opts.json ?? !process.stdout.isTTY;
      const chatFilter = opts.chats
        ? new Set(opts.chats.split(",").map((s) => s.trim()))
        : null;

      try {
        acquireLock();
      } catch (err) {
        console.error((err as Error).message);
        process.exit(EXIT_CONNECTION_FAILED);
      }

      const config = loadConfig();

      const onMessage = (msg: ParsedMessage) => {
        if (chatFilter && !chatFilter.has(msg.chatJid)) return;

        if (useJson) {
          console.log(
            JSON.stringify({
              id: msg.id,
              chat: msg.chatJid,
              sender: msg.senderJid,
              sender_name: msg.senderName,
              body: msg.body,
              type: msg.type,
              from_me: msg.isFromMe,
              timestamp: msg.timestamp,
              quoted_id: msg.quotedId,
            })
          );
        } else {
          const ts = formatTimestamp(msg.timestamp);
          const sender = msg.senderName || msg.senderJid || "me";
          console.log(`[${ts}] ${sender}: ${msg.body || `<${msg.type}>`}`);
        }
      };

      try {
        const { sock, flushCreds } = await createConnection({
          onOpen: () => {
            if (!useJson) console.error("Connected — listening for messages...");
          },
        });

        await waitForConnection(sock);
        startListener(sock, { config, onMessage });

        // Graceful shutdown
        const shutdown = async () => {
          if (!useJson) console.error("\nShutting down...");
          await flushCreds();
          sock.end(undefined);
          closeDb();
          releaseLock();
          process.exit(0);
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
      } catch (err) {
        console.error("Connection failed:", (err as Error).message);
        releaseLock();
        process.exit(EXIT_CONNECTION_FAILED);
      }
    });
}
