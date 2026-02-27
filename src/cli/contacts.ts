import { Command } from "commander";
import { listContacts, searchContacts } from "../core/store.js";
import { outputResult } from "./format.js";
import { EXIT_NOT_FOUND } from "./exit-codes.js";

export function registerContactsCommand(program: Command): void {
  const contacts = program
    .command("contacts")
    .description("List, search, and view contacts");

  contacts
    .command("list")
    .description("List all contacts")
    .option("--limit <n>", "Max contacts to show", "100")
    .option("--json", "Output as JSON")
    .action((opts: { limit: string; json?: boolean }) => {
      const rows = listContacts({ limit: parseInt(opts.limit, 10) });

      if (rows.length === 0) {
        console.log(
          "No contacts found. Run `wu daemon` or `wu listen` to collect data."
        );
        return;
      }

      if (opts.json) {
        outputResult(rows, { json: true });
      } else {
        for (const row of rows) {
          const name = row.push_name || row.saved_name || "unknown";
          console.log(`${name}  ${row.phone || row.jid}  ${row.jid}`);
        }
      }
    });

  contacts
    .command("search <query>")
    .description("Search contacts by name or phone")
    .option("--limit <n>", "Max results", "100")
    .option("--json", "Output as JSON")
    .action(
      (query: string, opts: { limit: string; json?: boolean }) => {
        const rows = searchContacts(query, {
          limit: parseInt(opts.limit, 10),
        });

        if (rows.length === 0) {
          console.log("No contacts found matching query.");
          return;
        }

        if (opts.json) {
          outputResult(rows, { json: true });
        } else {
          for (const row of rows) {
            const name = row.push_name || row.saved_name || "unknown";
            console.log(`${name}  ${row.phone || row.jid}  ${row.jid}`);
          }
        }
      }
    );

  contacts
    .command("info <jid>")
    .description("Show contact details")
    .option("--json", "Output as JSON")
    .action((jid: string, opts: { json?: boolean }) => {
      const rows = searchContacts(jid, { limit: 1 });
      // Also try exact match from listContacts
      const allContacts = listContacts({ limit: 10000 });
      const contact = allContacts.find((c) => c.jid === jid);

      if (!contact) {
        console.error(`Contact not found: ${jid}`);
        process.exit(EXIT_NOT_FOUND);
      }

      outputResult(contact, { json: opts.json });
    });
}
