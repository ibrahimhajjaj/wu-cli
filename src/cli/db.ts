import { Command } from "commander";
import { createInterface } from "readline";
import { unlinkSync, existsSync } from "fs";
import { getDb, closeDb } from "../db/database.js";
import { DB_PATH } from "../config/paths.js";

function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

export function registerDbCommand(program: Command): void {
  const db = program.command("db").description("Database maintenance");

  db.command("vacuum")
    .description("Run VACUUM and ANALYZE on the database")
    .action(() => {
      const database = getDb();
      console.log("Running VACUUM...");
      database.exec("VACUUM");
      console.log("Running ANALYZE...");
      database.exec("ANALYZE");
      closeDb();
      console.log("Done.");
    });

  db.command("reindex")
    .description("Rebuild the full-text search index (fixes 'database disk image is malformed' on search)")
    .action(() => {
      const database = getDb();
      console.log("Rebuilding search index...");
      database.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
      database.pragma("wal_checkpoint(TRUNCATE)");
      // Confirm the rank-sorted read path (the one that fails on a corrupt
      // index) works now.
      try {
        database.prepare(
          "SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'a' ORDER BY rank LIMIT 1"
        ).get();
        console.log("Done — search index rebuilt and verified.");
      } catch (err) {
        console.error(`Rebuilt, but a ranked read still failed: ${(err as Error).message}`);
      }
      closeDb();
    });

  db.command("reset")
    .description("Delete the database and start fresh")
    .option("-y, --yes", "Skip confirmation")
    .action(async (opts: { yes?: boolean }) => {
      if (!existsSync(DB_PATH)) {
        console.log("No database found. Nothing to reset.");
        return;
      }

      if (!opts.yes) {
        const ok = await confirm("This will delete all collected messages, chats, and contacts. Continue? [y/N] ");
        if (!ok) {
          console.log("Aborted.");
          return;
        }
      }

      closeDb();
      unlinkSync(DB_PATH);
      // Remove WAL/SHM journal files if they exist
      for (const suffix of ["-wal", "-shm"]) {
        const p = DB_PATH + suffix;
        if (existsSync(p)) unlinkSync(p);
      }
      console.log("Database deleted. Run `wu daemon` or `wu listen` to start collecting again.");
    });
}
