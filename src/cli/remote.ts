import { Command } from "commander";
import { parse as parseYaml } from "yaml";
import { loadConfig, saveConfig, WuConfigSchema } from "../config/schema.js";
import { sshWuExec, sshRawExec, remotePath } from "../core/remote.js";
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

  remote
    .command("setup <name>")
    .description("Sync constraints between local and remote")
    .option("--push", "Push local constraints to remote")
    .option("--pull", "Pull remote constraints to local")
    .action(async (name: string, opts: { push?: boolean; pull?: boolean }) => {
      const config = loadConfig();
      const remoteConfig = config.remotes?.[name];
      if (!remoteConfig) {
        console.error(`Remote '${name}' not found`);
        process.exit(EXIT_GENERAL_ERROR);
      }

      // Default: pull if no local constraints, push if local has them
      let direction = opts.push ? "push" : opts.pull ? "pull" : undefined;

      if (!direction) {
        const hasLocal = !!config.constraints;
        direction = hasLocal ? "push" : "pull";
        process.stderr.write(`Auto-detected direction: ${direction}\n`);
      }

      if (direction === "push") {
        if (!config.constraints) {
          console.error("No local constraints to push. Set some first:");
          console.error("  wu config set constraints.default full");
          process.exit(EXIT_GENERAL_ERROR);
        }

        // Set default constraint
        const setDefault = await sshWuExec(remoteConfig, [
          "config", "set", "constraints.default", config.constraints.default,
        ]);
        if (setDefault.exitCode !== 0) {
          console.error(`Failed to set remote default constraint: ${setDefault.stderr}`);
          process.exit(EXIT_GENERAL_ERROR);
        }
        console.log(`Pushed default constraint: ${config.constraints.default}`);

        // Set per-chat constraints
        for (const [jid, chat] of Object.entries(config.constraints.chats)) {
          const setChat = await sshWuExec(remoteConfig, [
            "config", "set", `constraints.chats.${jid}.mode`, chat.mode,
          ]);
          if (setChat.exitCode !== 0) {
            console.error(`Failed to set constraint for ${jid}: ${setChat.stderr}`);
          } else {
            console.log(`Pushed constraint: ${jid} = ${chat.mode}`);
          }
        }

        console.log("Constraints pushed to remote");
      } else {
        // Pull remote config file directly (wu config show outputs YAML)
        const result = await sshRawExec(remoteConfig, `cat ${remotePath(remoteConfig.wu_home + "/config.yaml")}`);
        if (result.exitCode !== 0) {
          console.error(`Failed to read remote config: ${result.stderr}`);
          process.exit(EXIT_GENERAL_ERROR);
        }

        let remoteFullConfig;
        try {
          const parsed = parseYaml(result.stdout);
          remoteFullConfig = WuConfigSchema.parse(parsed || {});
        } catch {
          console.error("Failed to parse remote config");
          process.exit(EXIT_GENERAL_ERROR);
        }

        if (!remoteFullConfig.constraints) {
          console.log("Remote has no constraints configured");
          return;
        }

        config.constraints = remoteFullConfig.constraints;
        saveConfig(config);
        console.log(`Pulled constraints from remote:`);
        console.log(`  default: ${config.constraints.default}`);
        const chatEntries = Object.entries(config.constraints.chats);
        if (chatEntries.length > 0) {
          for (const [jid, chat] of chatEntries) {
            console.log(`  ${jid}: ${chat.mode}`);
          }
        }
      }
    });
}
