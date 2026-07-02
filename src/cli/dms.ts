import { Command } from "commander";
import { listDmsForConfig, searchDmsForConfig } from "../core/service.js";
import { loadConfig } from "../config/schema.js";
import { resolveConstraint } from "../core/constraints.js";
import { outputResult, formatTimestamp } from "./format.js";

export function registerDmsCommand(program: Command): void {
  const dms = program
    .command("dms")
    .description("List and search 1:1 (direct message) chats");

  dms
    .command("list")
    .description("List 1:1 chats (constraint-gated; DM JIDs contain phone numbers)")
    .option("--limit <n>", "Max chats to show", "100")
    .option("--all", "Include DMs blocked by constraints (jid only)")
    .option("--json", "Output as JSON")
    .action((opts: { limit: string; all?: boolean; json?: boolean }) => {
      const config = loadConfig();
      const limit = parseInt(opts.limit, 10);
      const visible = listDmsForConfig(config, { limit, includeBlocked: opts.all });

      if (visible.length === 0) {
        // Distinguish "nothing cached" from "cached but filtered out" without
        // fetching the full table - a bounded existence probe is enough.
        const anyDms = listDmsForConfig(config, { limit: 1, includeBlocked: true });
        if (anyDms.length === 0) {
          console.log("No 1:1 chats cached yet. Run `wu daemon` to start collecting.");
        } else {
          console.log(
            "No 1:1 chats match your constraints. Pass --all to see blocked JIDs " +
              "or `wu config allow <jid>` to opt in."
          );
        }
        return;
      }

      if (opts.json) {
        outputResult(
          visible.map((r) => ({
            jid: r.jid,
            name: r.name,
            constraint: resolveConstraint(r.jid, config),
            last_message_at: r.last_message_at,
          })),
          { json: true }
        );
        return;
      }

      for (const row of visible) {
        const status = resolveConstraint(row.jid, config);
        const last = row.last_message_at ? formatTimestamp(row.last_message_at) : "never";
        const name = row.name || row.jid;
        console.log(`${name}  [${status}]  ${row.jid}  last: ${last}`);
      }
    });

  dms
    .command("search <query>")
    .description("Search 1:1 chats by name")
    .option("--limit <n>", "Max results", "100")
    .option("--json", "Output as JSON")
    .action((query: string, opts: { limit: string; json?: boolean }) => {
      const config = loadConfig();
      const limit = parseInt(opts.limit, 10);
      const rows = searchDmsForConfig(config, query, { limit });

      if (rows.length === 0) {
        console.log("No 1:1 chats found matching query.");
        return;
      }

      if (opts.json) {
        outputResult(rows, { json: true });
      } else {
        for (const r of rows) {
          console.log(`${r.name || r.jid}  ${r.jid}`);
        }
      }
    });
}
