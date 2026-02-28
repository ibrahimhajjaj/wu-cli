import { Command } from "commander";
import { statSync } from "fs";
import { loadConfig } from "../config/schema.js";
import { DB_PATH } from "../config/paths.js";
import { getDefaultRemote, syncDb } from "../core/remote.js";
import { generateSyncService, generateSyncTimer } from "../core/systemd.js";
import { EXIT_GENERAL_ERROR } from "./exit-codes.js";

export function registerSyncCommand(program: Command): void {
  const sync = program
    .command("sync")
    .description("Sync database from a remote wu instance");

  sync
    .command("pull [remote-name]")
    .description("Pull database from remote")
    .option("--watch", "Continuously sync on an interval")
    .option("--interval <seconds>", "Sync interval in seconds (with --watch)", "30")
    .action(async (remoteName: string | undefined, opts: { watch?: boolean; interval: string }) => {
      const config = loadConfig();
      const resolved = resolveRemote(config, remoteName);

      const doPull = async () => {
        const start = Date.now();
        process.stderr.write(`Syncing from '${resolved.name}' (${resolved.remote.host})...\n`);

        try {
          const result = await syncDb(resolved.remote, DB_PATH);
          const elapsed = ((Date.now() - start) / 1000).toFixed(1);
          let size = "unknown";
          try {
            const s = statSync(DB_PATH);
            size = `${(s.size / 1048576).toFixed(1)}MB`;
          } catch {}

          process.stderr.write(`Synced via ${result.method} in ${elapsed}s (${size})\n`);
        } catch (err) {
          process.stderr.write(`Sync failed: ${(err as Error).message}\n`);
          if (!opts.watch) process.exit(EXIT_GENERAL_ERROR);
        }
      };

      await doPull();

      if (opts.watch) {
        const intervalSec = parseInt(opts.interval, 10);
        process.stderr.write(`Watching — sync every ${intervalSec}s (Ctrl+C to stop)\n`);

        let running = true;
        const stop = () => {
          running = false;
          process.stderr.write("Stopped.\n");
          process.exit(0);
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);

        while (running) {
          await new Promise((r) => setTimeout(r, intervalSec * 1000));
          if (running) await doPull();
        }
      }
    });

  sync
    .command("install")
    .description("Install systemd timer for periodic sync")
    .option("--interval <seconds>", "Sync interval in seconds", "60")
    .action(async (opts: { interval: string }) => {
      const config = loadConfig();
      const resolved = getDefaultRemote(config);
      if (!resolved) {
        console.error("No remote configured. Add one first: wu remote add <name> <user@host>");
        process.exit(EXIT_GENERAL_ERROR);
      }

      const interval = parseInt(opts.interval, 10);
      await generateSyncService();
      await generateSyncTimer(interval);
      console.log(`Sync timer installed (every ${interval}s)`);
    });

  sync
    .command("uninstall")
    .description("Remove systemd sync timer")
    .action(async () => {
      const { execFileSync } = await import("child_process");
      const units = ["wu-sync.timer", "wu-sync.service"];
      for (const unit of units) {
        try { execFileSync("systemctl", ["--user", "disable", "--now", unit], { stdio: "pipe" }); } catch {}
      }
      const { join } = await import("path");
      const { homedir } = await import("os");
      const { unlinkSync } = await import("fs");
      const dir = join(homedir(), ".config", "systemd", "user");
      for (const unit of units) {
        try { unlinkSync(join(dir, unit)); } catch {}
      }
      try { execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe" }); } catch {}
      console.log("Sync timer removed");
    });
}

function resolveRemote(config: ReturnType<typeof loadConfig>, name?: string) {
  if (name) {
    const remote = config.remotes?.[name];
    if (!remote) {
      console.error(`Remote '${name}' not found`);
      process.exit(EXIT_GENERAL_ERROR);
    }
    return { name, remote };
  }

  const resolved = getDefaultRemote(config);
  if (!resolved) {
    const remotes = config.remotes ? Object.keys(config.remotes) : [];
    if (remotes.length === 0) {
      console.error("No remotes configured. Add one first: wu remote add <name> <user@host>");
    } else {
      console.error("Multiple remotes configured. Specify which one or set a default:");
      console.error(`  wu sync pull <name>`);
      console.error(`  wu remote default <name>`);
    }
    process.exit(EXIT_GENERAL_ERROR);
  }

  return resolved;
}
