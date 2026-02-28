import { Command } from "commander";
import { loadConfig, saveConfig } from "../config/schema.js";
import { sshWuExec } from "../core/remote.js";
import { EXIT_GENERAL_ERROR } from "./exit-codes.js";

export function registerRemoteCommand(program: Command): void {
  const remote = program
    .command("remote")
    .description("Manage remote wu instances (VPS daemon connections)");

  remote
    .command("add <name> <host>")
    .description("Add a remote wu instance")
    .option("--wu-home <path>", "Remote wu home directory", "~/.wu")
    .action(async (name: string, host: string, opts: { wuHome: string }) => {
      const config = loadConfig();
      if (config.remotes?.[name]) {
        console.error(`Remote '${name}' already exists. Remove it first with: wu remote remove ${name}`);
        process.exit(EXIT_GENERAL_ERROR);
      }

      const remoteConfig = { host, wu_home: opts.wuHome };

      // Test SSH connectivity + wu installation
      process.stderr.write(`Testing SSH connection to ${host}...\n`);
      const result = await sshWuExec(remoteConfig, ["--version"]);
      if (result.exitCode !== 0) {
        console.error(`Failed to connect or wu not installed on ${host}:`);
        console.error(result.stderr || "SSH connection failed");
        process.exit(EXIT_GENERAL_ERROR);
      }
      process.stderr.write(`Connected — remote wu ${result.stdout.trim()}\n`);

      // Save to config
      if (!config.remotes) config.remotes = {};
      config.remotes[name] = remoteConfig;

      // First remote auto-becomes default
      if (Object.keys(config.remotes).length === 1) {
        config.default_remote = name;
      }

      saveConfig(config);
      console.log(`Remote '${name}' added (${host})`);
      if (config.default_remote === name) {
        console.log(`Set as default remote`);
      }
    });

  remote
    .command("list")
    .description("List configured remotes")
    .action(() => {
      const config = loadConfig();
      const remotes = config.remotes;
      if (!remotes || Object.keys(remotes).length === 0) {
        console.log("No remotes configured. Add one with: wu remote add <name> <user@host>");
        return;
      }

      for (const [name, r] of Object.entries(remotes)) {
        const isDefault = config.default_remote === name ? " *" : "";
        console.log(`${name}${isDefault}\t${r.host}\t${r.wu_home}`);
      }
    });

  remote
    .command("remove <name>")
    .description("Remove a remote")
    .action((name: string) => {
      const config = loadConfig();
      if (!config.remotes?.[name]) {
        console.error(`Remote '${name}' not found`);
        process.exit(EXIT_GENERAL_ERROR);
      }

      delete config.remotes[name];
      if (config.default_remote === name) {
        config.default_remote = undefined;
      }

      // Clean up empty remotes object
      if (Object.keys(config.remotes).length === 0) {
        config.remotes = undefined;
      }

      saveConfig(config);
      console.log(`Remote '${name}' removed`);
    });

  remote
    .command("default <name>")
    .description("Set the default remote")
    .action((name: string) => {
      const config = loadConfig();
      if (!config.remotes?.[name]) {
        console.error(`Remote '${name}' not found. Available remotes:`);
        if (config.remotes) {
          for (const n of Object.keys(config.remotes)) {
            console.error(`  ${n}`);
          }
        }
        process.exit(EXIT_GENERAL_ERROR);
      }

      config.default_remote = name;
      saveConfig(config);
      console.log(`Default remote set to '${name}'`);
    });
}
