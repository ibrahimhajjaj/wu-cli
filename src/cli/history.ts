import { Command } from "commander";
import { createConnection, waitForConnection } from "../core/connection.js";
import { startListener } from "../core/listener.js";
import { backfillHistory } from "../core/backfill.js";
import { acquireLock, isLocked, releaseLock } from "../core/lock.js";
import { daemonIpcAvailable, daemonRequest } from "../core/ipc.js";
import { loadConfig } from "../config/schema.js";
import { closeDb } from "../db/database.js";
import { outputResult } from "./format.js";
import { EXIT_GENERAL_ERROR, EXIT_CONNECTION_FAILED } from "./exit-codes.js";

interface BackfillResult {
  requested: number;
  newMessages: number;
  oldestTimestamp: number | null;
}

function printResult(result: BackfillResult, json?: boolean): void {
  if (json) {
    outputResult(result, { json: true });
    return;
  }
  console.log(`Requested: ${result.requested}`);
  console.log(`New messages: ${result.newMessages}`);
  if (result.oldestTimestamp) {
    console.log(`Oldest: ${new Date(result.oldestTimestamp * 1000).toISOString()}`);
  }
}

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
      const countRaw = parseInt(opts.count, 10);
      const count = Number.isFinite(countRaw) && countRaw > 0 ? countRaw : 50;
      const timeoutRaw = parseInt(opts.timeout, 10);
      const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 30_000;

      // A running daemon already holds the only WhatsApp session, so ask it to
      // fetch on that connection over IPC rather than opening a second login -
      // WhatsApp treats a competing session as a rival and can drop both.
      if (await daemonIpcAvailable()) {
        try {
          const result = await daemonRequest<BackfillResult>(
            "history.backfill",
            { jid, count, timeoutMs },
            Math.max(300_000, timeoutMs + 30_000)
          );
          printResult(result, opts.json);
        } catch (err) {
          console.error((err as Error).message);
          process.exit(EXIT_GENERAL_ERROR);
        }
        return;
      }

      // The lock is held but nothing answers on IPC (e.g. `wu listen`, which
      // holds the session without an IPC server). Opening our own connection
      // would collide, so refuse with a concrete next step instead.
      const lock = isLocked();
      if (lock.locked) {
        console.error(
          `Another wu process (PID ${lock.pid}) holds the WhatsApp session but does not serve backfill over IPC. Stop it, or run \`wu daemon\` which supports backfill while running.`
        );
        process.exit(EXIT_GENERAL_ERROR);
      }

      // No daemon: run a one-shot connection ourselves under the lock.
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
        printResult(result, opts.json);

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
