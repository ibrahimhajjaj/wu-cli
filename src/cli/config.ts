import { Command } from "commander";
import { stringify as stringifyYaml } from "yaml";
import {
  loadConfig,
  saveConfig,
  setConfigValue,
  type ConstraintMode,
} from "../config/schema.js";
import { CONFIG_PATH } from "../config/paths.js";

const VALID_MODES = ["full", "read", "none"] as const;

function isValidMode(v: string): v is ConstraintMode {
  return (VALID_MODES as readonly string[]).includes(v);
}

function ensureConstraints(config: ReturnType<typeof loadConfig>) {
  if (!config.constraints) {
    config.constraints = { default: "none", chats: {} };
  }
  return config.constraints;
}

export function registerConfigCommand(program: Command): void {
  const config = program.command("config").description("Manage wu configuration");

  config
    .command("show")
    .description("Print current configuration")
    .action(() => {
      const cfg = loadConfig();
      console.log(stringifyYaml(cfg));
    });

  config
    .command("set <path> <value>")
    .description("Set a config value (dot-notation path)")
    .action((dotPath: string, value: string) => {
      const updated = setConfigValue(dotPath, value);
      console.log(
        `Set ${dotPath} = ${JSON.stringify((updated as Record<string, unknown>)[dotPath.split(".")[0]])}`
      );
    });

  config
    .command("path")
    .description("Print config file path")
    .action(() => {
      console.log(CONFIG_PATH);
    });

  // --- Constraint commands ---

  config
    .command("allow <jid>")
    .description("Allow a chat (full access: read + write + manage)")
    .option("--mode <mode>", "Access mode: full or read (default: full)", "full")
    .action((jid: string, opts: { mode: string }) => {
      const mode = opts.mode;
      if (mode !== "full" && mode !== "read") {
        console.error(`Invalid mode "${mode}". Use "full" or "read".`);
        process.exit(1);
      }

      const cfg = loadConfig();
      const constraints = ensureConstraints(cfg);
      constraints.chats[jid] = { mode };
      saveConfig(cfg);
      console.log(`${jid} → ${mode}`);
    });

  config
    .command("block <jid>")
    .description("Block a chat (drop all messages, no access)")
    .action((jid: string) => {
      const cfg = loadConfig();
      const constraints = ensureConstraints(cfg);
      constraints.chats[jid] = { mode: "none" };
      saveConfig(cfg);
      console.log(`${jid} → none`);
    });

  config
    .command("remove <jid>")
    .description("Remove a chat constraint (falls back to default)")
    .action((jid: string) => {
      const cfg = loadConfig();
      const constraints = ensureConstraints(cfg);
      if (constraints.chats[jid]) {
        delete constraints.chats[jid];
        saveConfig(cfg);
        console.log(`Removed ${jid} — falls back to default (${constraints.default})`);
      } else {
        console.log(`No constraint found for ${jid}`);
      }
    });

  config
    .command("default [mode]")
    .description("Get or set the default constraint mode (full, read, none)")
    .action((mode?: string) => {
      if (!mode) {
        const cfg = loadConfig();
        const def = cfg.constraints?.default ?? "none";
        console.log(`Default constraint: ${def}`);
        return;
      }

      if (!isValidMode(mode)) {
        console.error(`Invalid mode "${mode}". Use: full, read, none`);
        process.exit(1);
      }

      const cfg = loadConfig();
      const constraints = ensureConstraints(cfg);
      constraints.default = mode;
      saveConfig(cfg);
      console.log(`Default constraint → ${mode}`);
    });

  config
    .command("constraints")
    .description("Show all constraints")
    .action(() => {
      const cfg = loadConfig();
      const constraints = cfg.constraints;

      if (!constraints || Object.keys(constraints.chats).length === 0) {
        console.log(`Default: ${constraints?.default ?? "none"}`);
        console.log("No per-chat constraints configured.");
        return;
      }

      console.log(`Default: ${constraints.default}\n`);

      const entries = Object.entries(constraints.chats);
      const maxJid = Math.max(...entries.map(([jid]) => jid.length));

      for (const [jid, { mode }] of entries) {
        console.log(`  ${jid.padEnd(maxJid)}  ${mode}`);
      }
    });
}
