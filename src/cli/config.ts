import { Command } from "commander";
import { stringify as stringifyYaml } from "yaml";
import {
  loadConfig,
  setConfigValue,
  type ConstraintMode,
} from "../config/schema.js";
import {
  saveConstraints,
  propagateConstraints,
  describePropagation,
  type PropagateResult,
} from "../core/constraint-sync.js";
import { EXIT_GENERAL_ERROR } from "./exit-codes.js";
import { CONFIG_PATH, DB_PATH } from "../config/paths.js";
import { getChat } from "../core/service.js";
import { existsSync } from "fs";

const VALID_MODES = ["full", "read", "none"] as const;

function isValidMode(v: string): v is ConstraintMode {
  return (VALID_MODES as readonly string[]).includes(v);
}

// A constraint that never reached the collector is worse than a failed write,
// because the local config then disagrees with what is actually being collected.
// Say so and exit non-zero rather than printing a success line only.
function reportSync(result: PropagateResult): void {
  const note = describePropagation(result);
  if (note) console.log(note);
  if (result.status === "failed") process.exit(EXIT_GENERAL_ERROR);
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
    .action(async (dotPath: string, value: string) => {
      const updated = setConfigValue(dotPath, value);
      console.log(
        `Set ${dotPath} = ${JSON.stringify((updated as Record<string, unknown>)[dotPath.split(".")[0]])}`
      );
      // Constraints reached this way have to travel to the collector too - this
      // is the command `wu remote setup --push` points people at.
      if (dotPath.split(".")[0] === "constraints") {
        reportSync(await propagateConstraints(loadConfig()));
      }
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
    .action(async (jid: string, opts: { mode: string }) => {
      const mode = opts.mode;
      if (mode !== "full" && mode !== "read") {
        console.error(`Invalid mode "${mode}". Use "full" or "read".`);
        process.exit(1);
      }

      const cfg = loadConfig();
      const constraints = ensureConstraints(cfg);
      constraints.chats[jid] = { mode };
      const sync = await saveConstraints(cfg);
      console.log(`${jid} → ${mode}`);
      reportSync(sync);
    });

  config
    .command("block <jid>")
    .description("Block a chat (drop all messages, no access)")
    .action(async (jid: string) => {
      const cfg = loadConfig();
      const constraints = ensureConstraints(cfg);
      constraints.chats[jid] = { mode: "none" };
      const sync = await saveConstraints(cfg);
      console.log(`${jid} → none`);
      reportSync(sync);
    });

  config
    .command("remove <jid>")
    .description("Remove a chat constraint (falls back to default)")
    .action(async (jid: string) => {
      const cfg = loadConfig();
      const constraints = ensureConstraints(cfg);
      if (constraints.chats[jid]) {
        delete constraints.chats[jid];
        const sync = await saveConstraints(cfg);
        console.log(`Removed ${jid} — falls back to default (${constraints.default})`);
        reportSync(sync);
      } else {
        console.log(`No constraint found for ${jid}`);
      }
    });

  config
    .command("default [mode]")
    .description("Get or set the default constraint mode (full, read, none)")
    .action(async (mode?: string) => {
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
      const sync = await saveConstraints(cfg);
      console.log(`Default constraint → ${mode}`);
      reportSync(sync);
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

      const dbExists = existsSync(cfg.db?.path || DB_PATH);
      const maxMode = Math.max(...entries.map(([, { mode }]) => mode.length));

      for (const [jid, { mode }] of entries) {
        let namePart = "";
        if (dbExists && !jid.startsWith("*")) {
          const row = getChat(jid);
          if (row?.name) {
            const count = row.participant_count ? ` (${row.participant_count})` : "";
            namePart = `  ${row.name}${count}`;
          }
        }
        const modePad = namePart ? mode.padEnd(maxMode) : mode;
        console.log(`  ${jid.padEnd(maxJid)}  ${modePad}${namePart}`);
      }
    });
}
