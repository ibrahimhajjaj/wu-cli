import { Command } from "commander";
import { withConnection } from "../core/connection.js";
import { downloadMedia, downloadMediaBatch } from "../core/media.js";
import { sendMedia } from "../core/sender.js";
import { loadConfig } from "../config/schema.js";
import { getDb } from "../db/database.js";
import { outputResult } from "./format.js";
import { EXIT_GENERAL_ERROR, EXIT_NOT_FOUND } from "./exit-codes.js";

export function registerMediaCommand(program: Command): void {
  const media = program.command("media").description("Download and send media");

  media
    .command("download <msg-id>")
    .description("Download media from a message")
    .option("--out <dir>", "Output directory")
    .option("--json", "Output as JSON")
    .action(async (msgId: string, opts: { out?: string; json?: boolean }) => {
      const config = loadConfig();
      try {
        await withConnection(async (sock) => {
          const result = await downloadMedia(msgId, sock, config, opts.out);
          if (opts.json) {
            console.log(JSON.stringify(result));
          } else {
            console.log(`Downloaded: ${result.path}`);
            console.log(`Type: ${result.mime}`);
            console.log(`Size: ${(result.size / 1024).toFixed(1)} KB`);
          }
        });
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes("not found")) {
          console.error(msg);
          process.exit(EXIT_NOT_FOUND);
        }
        console.error(msg);
        process.exit(EXIT_GENERAL_ERROR);
      }
    });

  media
    .command("send <jid> <path>")
    .description("Send a media file")
    .option("--caption <text>", "Caption for the media")
    .option("--json", "Output as JSON")
    .action(
      async (
        jid: string,
        filePath: string,
        opts: { caption?: string; json?: boolean }
      ) => {
        const config = loadConfig();
        try {
          await withConnection(async (sock) => {
            const result = await sendMedia(sock, jid, filePath, config, {
              caption: opts.caption,
            });
            if (opts.json) {
              console.log(
                JSON.stringify({
                  id: result?.key?.id,
                  timestamp: result?.messageTimestamp,
                })
              );
            } else {
              console.log(`Sent: ${result?.key?.id}`);
            }
          });
        } catch (err) {
          const error = err as Error & { exitCode?: number };
          console.error(error.message);
          process.exit(error.exitCode || EXIT_GENERAL_ERROR);
        }
      }
    );

  media
    .command("download-batch <jid>")
    .description("Download undownloaded media in a chat (parallel)")
    .option("--limit <n>", "Max messages to download", "50")
    .option("--concurrency <n>", "Parallel workers", "4")
    .option("--out <dir>", "Output directory")
    .option("--json", "Output as JSON")
    .action(
      async (
        jid: string,
        opts: { limit: string; concurrency: string; out?: string; json?: boolean }
      ) => {
        const config = loadConfig();
        const limit = parseInt(opts.limit, 10);
        const concurrency = parseInt(opts.concurrency, 10);

        const db = getDb();
        const rows = db
          .prepare(
            "SELECT id FROM messages WHERE media_mime IS NOT NULL AND media_path IS NULL AND chat_jid = ? ORDER BY timestamp DESC LIMIT ?"
          )
          .all(jid, limit) as Array<{ id: string }>;

        if (rows.length === 0) {
          if (opts.json) {
            outputResult({ results: [], errors: [] }, { json: true });
          } else {
            console.log("No undownloaded media found.");
          }
          return;
        }

        if (!opts.json) {
          console.log(`Found ${rows.length} media to download (concurrency: ${concurrency})`);
        }

        try {
          await withConnection(async (sock) => {
            const { results, errors } = await downloadMediaBatch(
              rows.map((r) => r.id),
              sock,
              config,
              opts.out,
              {
                concurrency,
                onProgress: (completed, total) => {
                  if (!opts.json) {
                    process.stderr.write(`\r  ${completed}/${total}`);
                  }
                },
              }
            );

            if (!opts.json) process.stderr.write("\n");

            if (opts.json) {
              outputResult({ results, errors }, { json: true });
            } else {
              console.log(`Downloaded: ${results.length}`);
              if (errors.length > 0) {
                console.log(`Errors: ${errors.length}`);
                for (const e of errors) {
                  console.error(`  ${e.msgId}: ${e.error}`);
                }
              }
            }
          });
        } catch (err) {
          console.error((err as Error).message);
          process.exit(EXIT_GENERAL_ERROR);
        }
      }
    );
}
