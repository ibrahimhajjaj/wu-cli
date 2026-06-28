import { Command } from "commander";
import { execFileSync, execSync } from "child_process";
import { join } from "path";
import { homedir } from "os";
import { unlinkSync } from "fs";
import { ReconnectingConnection } from "../core/connection.js";
import { startListener } from "../core/listener.js";
import { DaemonState } from "../core/daemon-state.js";
import { startDaemonIpc } from "../core/ipc.js";
import { acquireLock, releaseLock } from "../core/lock.js";
import { loadConfig } from "../config/schema.js";
import { closeDb } from "../db/database.js";
import { getMessageCount, getStoreHealth } from "../core/store.js";
import { generateDaemonService, resolveWuBin, checkLinger } from "../core/systemd.js";
import { EXIT_CONNECTION_FAILED, EXIT_GENERAL_ERROR } from "./exit-codes.js";

function log(msg: string): void {
  process.stderr.write(`  ${msg}\n`);
}

async function runDaemon(): Promise<void> {
  try {
    acquireLock();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(EXIT_CONNECTION_FAILED);
  }

  const config = loadConfig();
  const startTime = Date.now();
  const state = new DaemonState();

  const conn = new ReconnectingConnection({
    isDaemon: true,
    quiet: true,
    onReady: (sock) => {
      log("● Connected — collecting messages");
      state.setOpen();
      state.attach(sock);
      startListener(sock, { config, quiet: true, onMessage: () => state.markMessage() });
    },
    onDisconnect: (reason) => {
      log("⚠ Disconnected — waiting for reconnection");
      state.setClosed(reason);
    },
    onReconnecting: (delayMs) => {
      log(`● Reconnecting in ${(delayMs / 1000).toFixed(0)}s...`);
      state.setConnecting();
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
    const age = state.streamAge();
    const ageStr = age == null ? "n/a" : `${age}s`;
    log(`♥ RSS: ${(mem.rss / 1048576).toFixed(0)}MB | Heap: ${(mem.heapUsed / 1048576).toFixed(0)}MB | Uptime: ${uptimeH}h | Messages: ${msgs} | Last event: ${ageStr} ago`);
  }, 5 * 60 * 1000);

  // Watchdog: a half-dead socket can keep reporting "open" while the event
  // stream silently stops. Two cases:
  //   1. The WebSocket itself dropped but no connection.update close fired, so
  //      the reconnect path never engaged. Catch this immediately off the ws
  //      state, which a quiet account never trips, only a genuinely dead socket.
  //   2. The ws still reports open but no frames arrive (deaf stream). Only this
  //      case needs the silence timer, kept long so an overnight-quiet account
  //      is not churned (each needless reconnect re-runs history sync).
  const staleSeconds = config.whatsapp.watchdog_stale_seconds;
  const watchdogInterval = setInterval(() => {
    state.recordStoreHealth(getStoreHealth());
    state.flush(); // keep updated_at fresh so "process alive, stream dead" is visible
    if (!state.isOpen()) return;

    const sock = conn.getSock();
    const wsOpen = (sock?.ws as { isOpen?: boolean } | undefined)?.isOpen ?? true;
    if (!wsOpen) {
      log("⚠ Socket dropped without a close event: restarting stream");
      state.markWatchdogRestart();
      conn.forceReconnect("watchdog: socket closed without notice");
      return;
    }

    if (staleSeconds <= 0) return;
    const age = state.streamAge();
    if (age != null && age >= staleSeconds) {
      log(`⚠ No events for ${age}s (threshold ${staleSeconds}s): restarting stream`);
      state.markWatchdogRestart();
      conn.forceReconnect(`watchdog: stream stale for ${age}s`);
    }
  }, 60 * 1000);
  watchdogInterval.unref?.();

  // IPC server — lets CLI/MCP media downloads reuse this live socket instead
  // of opening a second WhatsApp login (which would collide and drop both).
  const stopIpc = startDaemonIpc(() => conn.getSock(), config);

  // Graceful shutdown
  const shutdown = async () => {
    log("● Shutting down...");
    clearInterval(healthInterval);
    clearInterval(watchdogInterval);
    state.stop();
    stopIpc();
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
}

export function registerDaemonCommand(program: Command): void {
  const daemon = program
    .command("daemon")
    .description("Run as a foreground daemon — collect messages continuously")
    .action(runDaemon);

  daemon
    .command("install")
    .description("Install systemd user service for the daemon")
    .action(async () => {
      try {
        resolveWuBin();
      } catch (err) {
        console.error((err as Error).message);
        process.exit(EXIT_GENERAL_ERROR);
      }

      try {
        await generateDaemonService();
        console.log("Daemon service installed and started");
        console.log("Check status: systemctl --user status wu");

        if (!checkLinger()) {
          console.log("");
          console.log("Warning: linger not enabled — daemon will stop when you log out.");
          console.log("Run: sudo loginctl enable-linger $(whoami)");
        }
      } catch (err) {
        console.error(`Failed to install service: ${(err as Error).message}`);
        process.exit(EXIT_GENERAL_ERROR);
      }
    });

  daemon
    .command("uninstall")
    .description("Remove systemd daemon service")
    .action(() => {
      try { execFileSync("systemctl", ["--user", "disable", "--now", "wu"], { stdio: "pipe" }); } catch {}
      const dir = join(homedir(), ".config", "systemd", "user");
      try { unlinkSync(join(dir, "wu.service")); } catch {}
      try { execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe" }); } catch {}
      console.log("Daemon service removed");
    });

  daemon
    .command("logs")
    .description("Show daemon logs (journalctl)")
    .action(() => {
      try {
        execSync("journalctl --user -u wu -f --no-pager", { stdio: "inherit" });
      } catch {
        // User hit Ctrl+C or journalctl not available
      }
    });
}
