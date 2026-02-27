import { Command } from "commander";
import { listChats, searchChats } from "../core/store.js";
import { outputResult, formatTimestamp } from "./format.js";

export function registerChatsCommand(program: Command): void {
  const chats = program.command("chats").description("List and search chats");

  chats
    .command("list")
    .description("List all chats")
    .option("--limit <n>", "Max chats to show", "100")
    .option("--json", "Output as JSON")
    .action((opts: { limit: string; json?: boolean }) => {
      const rows = listChats({ limit: parseInt(opts.limit, 10) });

      if (rows.length === 0) {
        console.log("No chats found. Run `wu daemon` or `wu listen` to collect data.");
        return;
      }

      if (opts.json) {
        outputResult(rows, { json: true });
      } else {
        for (const row of rows) {
          const lastMsg = row.last_message_at
            ? formatTimestamp(row.last_message_at)
            : "never";
          const name = row.name || row.jid;
          console.log(`${name}  [${row.type}]  ${row.jid}  last: ${lastMsg}`);
        }
      }
    });

  chats
    .command("search <query>")
    .description("Search chats by name")
    .option("--limit <n>", "Max results", "100")
    .option("--json", "Output as JSON")
    .action((query: string, opts: { limit: string; json?: boolean }) => {
      const rows = searchChats(query, { limit: parseInt(opts.limit, 10) });

      if (rows.length === 0) {
        console.log("No chats found matching query.");
        return;
      }

      if (opts.json) {
        outputResult(rows, { json: true });
      } else {
        for (const row of rows) {
          const name = row.name || row.jid;
          console.log(`${name}  [${row.type}]  ${row.jid}`);
        }
      }
    });
}
