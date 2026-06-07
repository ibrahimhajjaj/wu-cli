import { Command } from "commander";
import { loadConfig } from "../config/schema.js";
import { enrichStatus } from "../core/enrich.js";
import { outputResult } from "./format.js";

export function registerEnrichCommand(program: Command): void {
  const enrich = program
    .command("enrich")
    .description("Media enrichment backends (transcription, OCR)");

  enrich
    .command("status")
    .description("Show which enrichment backends are configured and ready, and how to enable them")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => {
      const config = loadConfig();
      const rows = enrichStatus(config.enrich);

      if (opts.json) {
        outputResult(rows, { json: true });
        return;
      }

      for (const r of rows) {
        const mark = r.available ? "ready" : r.backend === "off" ? "off" : "not ready";
        console.log(`${r.capability.padEnd(11)} ${mark.padEnd(10)} ${r.detail}`);
        if (!r.available && r.enable_hint) {
          console.log(`            enable: ${r.enable_hint}`);
        }
      }
    });
}
