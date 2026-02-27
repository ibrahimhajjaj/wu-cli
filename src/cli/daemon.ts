import { Command } from "commander";
import { ReconnectingConnection } from "../core/connection.js";
import { startListener } from "../core/listener.js";
import { acquireLock, releaseLock } from "../core/lock.js";
import { loadConfig } from "../config/schema.js";
import { closeDb } from "../db/database.js";
import { getMessageCount } from "../core/store.js";
import { createChildLogger } from "../config/logger.js";
import { EXIT_CONNECTION_FAILED } from "./exit-codes.js";

const logger = createChildLogger("daemon");

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
        onReady: (sock) => {
          logger.info("Connected — starting message collection");
          startListener(sock, { config });
        },
        onDisconnect: () => {
          logger.warn("Disconnected — waiting for reconnection");
        },
      });

      // Health logging every 5 minutes
      const healthInterval = setInterval(() => {
        const mem = process.memoryUsage();
        const uptimeH = ((Date.now() - startTime) / 3600000).toFixed(1);
        const sock = conn.getSock();
        logger.info({
          rss_mb: (mem.rss / 1048576).toFixed(1),
          heap_mb: (mem.heapUsed / 1048576).toFixed(1),
          uptime_h: uptimeH,
          messages_stored: getMessageCount(),
          connected: sock ? (sock.ws as any)?.isOpen ?? false : false,
        }, "Health check");
      }, 5 * 60 * 1000);

      // Graceful shutdown
      const shutdown = async () => {
        logger.info("Shutting down daemon...");
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
        logger.info("Daemon started");
      } catch (err) {
        logger.error({ err }, "Failed to start daemon");
        releaseLock();
        process.exit(EXIT_CONNECTION_FAILED);
      }
    });
}
