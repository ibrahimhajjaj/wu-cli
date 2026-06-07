import { Command } from "commander";
import { withConnection } from "../core/connection.js";
import { downloadMedia, downloadMediaBatch, pruneMedia, parseDuration, enrichMessage } from "../core/media.js";
import { EnrichUnavailableError } from "../core/enrich.js";
import { daemonIpcAvailable, daemonRequest } from "../core/ipc.js";
import { sendMedia } from "../core/sender.js";
import { loadConfig } from "../config/schema.js";
import { getDb } from "../db/database.js";
import { outputResult } from "./format.js";
import { EXIT_GENERAL_ERROR, EXIT_NOT_FOUND } from "./exit-codes.js";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

interface DownloadResult { path: string; mime: string; size: number }
interface BatchResult {
  results: Array<{ msgId: string; path: string; mime: string; size: number }>;
  errors: Array<{ msgId: string; error: string }>;
}

export function registerMediaCommand(program: Command): void {
  const media = program.command("media").description("Download and send media");

  media
    .command("download <msg-id>")
    .description("Download media from a message")
    .option("--out <dir>", "Output directory")
    .option("--json", "Output as JSON")
    .action(async (msgId: string, opts: { out?: string; json?: boolean }) => {
      const config = loadConfig();
      const printOne = (result: DownloadResult) => {
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(`Downloaded: ${result.path}`);
          console.log(`Type: ${result.mime}`);
          console.log(`Size: ${(result.size / 1024).toFixed(1)} KB`);
        }
      };
      try {
        // Reuse the daemon's live socket when it's running, so we don't open a
        // second WhatsApp login that would collide with it.
        if (await daemonIpcAvailable()) {
          const result = await daemonRequest<DownloadResult>("media.download", {
            msgId,
            outDir: opts.out,
          });
          printOne(result);
        } else {
          await withConnection(async (sock) => {
            printOne(await downloadMedia(msgId, sock, config, opts.out));
          });
        }
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
    .command("download-batch [jid]")
    .description("Download undownloaded media in a chat (parallel)")
    .option("--ids <csv>", "Download specific message IDs (comma-separated) instead of a chat scan")
    .option("--limit <n>", "Max messages to download", "50")
    .option("--concurrency <n>", "Parallel workers", "4")
    .option("--out <dir>", "Output directory")
    .option("--json", "Output as JSON")
    .action(
      async (
        jid: string | undefined,
        opts: { ids?: string; limit: string; concurrency: string; out?: string; json?: boolean }
      ) => {
        const config = loadConfig();
        const limit = parseInt(opts.limit, 10);
        const concurrency = parseInt(opts.concurrency, 10);
        const explicitIds = opts.ids
          ? opts.ids.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined;

        if (!explicitIds && !jid) {
          console.error("Provide a chat JID or --ids");
          process.exit(EXIT_GENERAL_ERROR);
        }

        const printBatch = ({ results, errors }: BatchResult) => {
          if (opts.json) {
            outputResult({ results, errors }, { json: true });
          } else {
            console.log(`Downloaded: ${results.length}`);
            if (errors.length > 0) {
              console.log(`Errors: ${errors.length}`);
              for (const e of errors) console.error(`  ${e.msgId}: ${e.error}`);
            }
          }
        };

        try {
          // When the daemon owns the socket, hand the whole batch to it (it
          // resolves the chat's undownloaded media itself) rather than logging
          // in a second time.
          if (await daemonIpcAvailable()) {
            const res = await daemonRequest<BatchResult>("media.downloadBatch", {
              msgIds: explicitIds,
              chat: jid,
              limit,
              concurrency,
              outDir: opts.out,
            });
            if (res.results.length === 0 && res.errors.length === 0 && !opts.json) {
              console.log("No undownloaded media found.");
              return;
            }
            printBatch(res);
            return;
          }

          if (explicitIds) {
            await withConnection(async (sock) => {
              const { results, errors } = await downloadMediaBatch(
                explicitIds, sock, config, opts.out, { concurrency }
              );
              printBatch({ results, errors });
            });
            return;
          }

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
            printBatch({ results, errors });
          });
        } catch (err) {
          console.error((err as Error).message);
          process.exit(EXIT_GENERAL_ERROR);
        }
      }
    );

  media
    .command("transcribe <msg-id>")
    .description("Transcribe a voice/audio message to text (needs a configured backend; see 'wu enrich status')")
    .option("--json", "Output as JSON")
    .action(async (msgId: string, opts: { json?: boolean }) => {
      const config = loadConfig();
      try {
        const res = await enrichMessage("transcribe", msgId, config);
        if (opts.json) {
          outputResult(res, { json: true });
        } else {
          console.log(`Transcribed ${msgId} via ${res.backend} (${res.chars} chars)`);
        }
      } catch (err) {
        if (err instanceof EnrichUnavailableError) {
          console.error(err.message);
          process.exit(EXIT_GENERAL_ERROR);
        }
        const msg = (err as Error).message;
        console.error(msg);
        process.exit(msg.includes("not found") ? EXIT_NOT_FOUND : EXIT_GENERAL_ERROR);
      }
    });

  media
    .command("prune")
    .description("Delete downloaded media files (keeps the DB/exports; bytes are disposable)")
    .option("--older-than <dur>", "Only prune media older than this (e.g. 30d, 12h, 2w)")
    .option("--chat <jid>", "Limit to one chat")
    .option("--dry-run", "Report what would be freed without deleting")
    .option("--json", "Output as JSON")
    .action((opts: { olderThan?: string; chat?: string; dryRun?: boolean; json?: boolean }) => {
      let olderThanSec: number | undefined;
      if (opts.olderThan) {
        const parsed = parseDuration(opts.olderThan);
        if (parsed === null) {
          console.error(`Invalid duration: ${opts.olderThan} (try 30d, 12h, 2w)`);
          process.exit(EXIT_GENERAL_ERROR);
        }
        olderThanSec = parsed;
      }

      const result = pruneMedia({ olderThanSec, chatJid: opts.chat, dryRun: opts.dryRun });

      if (opts.json) {
        outputResult(result, { json: true });
      } else {
        const verb = opts.dryRun ? "Would free" : "Freed";
        console.log(`${verb} ${formatBytes(result.freed_bytes)} from ${result.pruned} file(s)`);
        if (result.missing > 0) {
          console.log(`${result.missing} record(s) already had no file on disk (path cleared)`);
        }
      }
    });
}
