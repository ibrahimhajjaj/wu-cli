import { Command } from "commander";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { AUTH_DIR } from "../config/paths.js";
import { isLocked } from "../core/lock.js";
import { EXIT_NOT_AUTHENTICATED } from "./exit-codes.js";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show connection status and account info")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => {
      const credsPath = join(AUTH_DIR, "creds.json");
      if (!existsSync(credsPath)) {
        if (opts.json) {
          console.log(JSON.stringify({ authenticated: false }));
        } else {
          console.log("Not authenticated. Run `wu login` to connect.");
        }
        process.exit(EXIT_NOT_AUTHENTICATED);
      }

      try {
        const creds = JSON.parse(readFileSync(credsPath, "utf-8"));
        const { locked } = isLocked();
        const info = {
          authenticated: true,
          daemon_running: locked,
          phone: creds.me?.id?.split(":")[0] || creds.me?.id || "unknown",
          name: creds.me?.name || "unknown",
          platform: creds.platform || "unknown",
          registered: creds.registered ?? false,
        };

        if (opts.json) {
          console.log(JSON.stringify(info, null, 2));
        } else {
          console.log(`Authenticated: yes`);
          console.log(`Phone: ${info.phone}`);
          console.log(`Name: ${info.name}`);
          console.log(`Platform: ${info.platform}`);
        }
      } catch {
        console.log("Session exists but credentials may be corrupted.");
        console.log("Try `wu logout` and `wu login` to re-authenticate.");
      }
    });
}
