import { Command } from "commander";
import { withConnection } from "../core/connection.js";
import { downloadMedia } from "../core/media.js";
import { sendMedia } from "../core/sender.js";
import { loadConfig } from "../config/schema.js";
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
}
