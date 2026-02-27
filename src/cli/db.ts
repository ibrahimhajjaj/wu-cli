import { Command } from "commander";
import { getDb, closeDb } from "../db/database.js";

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
}
