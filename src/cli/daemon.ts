import { Command } from "commander";
import { ReconnectingConnection } from "../core/connection.js";
import { startListener } from "../core/listener.js";
import { acquireLock, releaseLock } from "../core/lock.js";
import { loadConfig } from "../config/schema.js";
import { closeDb } from "../db/database.js";
import { getMessageCount } from "../core/store.js";
import { EXIT_CONNECTION_FAILED } from "./exit-codes.js";

function log(msg: string): void {
  process.stderr.write(`  ${msg}\n`);
}

export function registerDaemonCommand(program: Command): void {
  program
    .command("daemon")
    .description("Run as a foreground daemon — collect messages continuously")
    .action(async () => {
      try {
        acquireLock();
      } catch (err) {
        console.error((err as Error).message);
        process.exit(EXIT_CONNECTION_FAILED);
      }

      const config = loadConfig();
      const startTime = Date.now();

      const conn = new ReconnectingConnection({
        isDaemon: true,
        quiet: true,
        onReady: (sock) => {
          log("● Connected — collecting messages");
          startListener(sock, { config, quiet: true });
        },
        onDisconnect: () => {
          log("⚠ Disconnected — waiting for reconnection");
        },
        onReconnecting: (delayMs) => {
          log(`● Reconnecting in ${(delayMs / 1000).toFixed(0)}s...`);
        },
        onFatal: (reason) => {
          log(`✗ ${reason}`);
        },
      });

      // Health logging every 5 minutes
      const healthInterval = setInterval(() => {
        const mem = process.memoryUsage();
        const uptimeH = ((Date.now() - startTime) / 3600000).toFixed(1);
        const msgs = getMessageCount();
        log(`♥ RSS: ${(mem.rss / 1048576).toFixed(0)}MB | Heap: ${(mem.heapUsed / 1048576).toFixed(0)}MB | Uptime: ${uptimeH}h | Messages: ${msgs}`);
      }, 5 * 60 * 1000);

      // Graceful shutdown
      const shutdown = async () => {
        log("● Shutting down...");
        clearInterval(healthInterval);
        await conn.stop();
        closeDb();
        releaseLock();
        process.exit(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      try {
        await conn.start();
        log("● Daemon started");
      } catch (err) {
        log(`✗ Failed to start: ${(err as Error).message}`);
        releaseLock();
        process.exit(EXIT_CONNECTION_FAILED);
      }
    });
}
