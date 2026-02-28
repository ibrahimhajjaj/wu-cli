import { Command } from "commander";
import { createConnection, waitForConnection } from "../core/connection.js";
import { startListener } from "../core/listener.js";
import { backfillHistory } from "../core/backfill.js";
import { acquireLock, isLocked, releaseLock } from "../core/lock.js";
import { loadConfig } from "../config/schema.js";
import { closeDb } from "../db/database.js";
import { outputResult } from "./format.js";
import { EXIT_GENERAL_ERROR, EXIT_CONNECTION_FAILED } from "./exit-codes.js";

export function registerHistoryCommand(program: Command): void {
  const history = program
    .command("history")
    .description("Fetch older message history from WhatsApp");

  history
    .command("backfill <jid>")
    .description("Request older messages for a chat")
    .option("--count <n>", "Number of messages to request", "50")
    .option("--timeout <ms>", "Timeout in milliseconds", "30000")
    .option("--json", "Output as JSON")
    .action(async (jid: string, opts: { count: string; timeout: string; json?: boolean }) => {
      const count = parseInt(opts.count, 10);
      const timeoutMs = parseInt(opts.timeout, 10);

      const lock = isLocked();
      if (lock.locked) {
        console.error(
          `Daemon is running (PID ${lock.pid}). Stop it first (systemctl --user stop wu) or use the MCP tool.`
        );
        process.exit(EXIT_GENERAL_ERROR);
      }

      try {
        acquireLock();
      } catch (err) {
        console.error((err as Error).message);
        process.exit(EXIT_CONNECTION_FAILED);
      }

      const config = loadConfig();

      try {
        const { sock, flushCreds } = await createConnection({
          quiet: true,
          onOpen: () => {
            if (!opts.json) console.error("Connected — requesting history...");
          },
        });

        await waitForConnection(sock);
        startListener(sock, { config, quiet: true });

        const result = await backfillHistory(sock, jid, count, config, { timeoutMs });

        if (opts.json) {
          outputResult(result, { json: true });
        } else {
          console.log(`Requested: ${result.requested}`);
          console.log(`New messages: ${result.newMessages}`);
          if (result.oldestTimestamp) {
            console.log(`Oldest: ${new Date(result.oldestTimestamp * 1000).toISOString()}`);
          }
        }

        await flushCreds();
        sock.end(undefined);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(EXIT_GENERAL_ERROR);
      } finally {
        closeDb();
        releaseLock();
      }
    });
}
