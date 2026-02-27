import { Command } from "commander";
import qrcode from "qrcode-terminal";
import { rmSync, existsSync } from "fs";
import { DisconnectReason } from "@whiskeysockets/baileys";
import {
  createConnection,
  waitForConnection,
  ConnectionError,
} from "../core/connection.js";
import { AUTH_DIR } from "../config/paths.js";
import { EXIT_CONNECTION_FAILED, EXIT_NOT_AUTHENTICATED } from "./exit-codes.js";

export function registerLoginCommand(program: Command): void {
  program
    .command("login")
    .description("Authenticate with WhatsApp (QR code or pairing code)")
    .option(
      "--code <phone>",
      "Use pairing code instead of QR (provide phone number with country code)"
    )
    .action(async (opts: { code?: string }) => {
      console.log("Connecting to WhatsApp...");

      const maxAttempts = 5;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const { sock, flushCreds } = await createConnection({
          quiet: true,
          pairingPhone: opts.code,
          onQr: (qr) => {
            console.log("\nScan this QR code with WhatsApp:\n");
            qrcode.generate(qr, { small: true });
          },
          onPairingCode: (code) => {
            console.log(`\nPairing code: ${code}`);
            console.log(
              "Enter this code in WhatsApp > Linked Devices > Link a Device\n"
            );
          },
          onOpen: () => {
            console.log("Connected successfully!");
          },
        });

        try {
          await waitForConnection(sock);

          const me = sock.user;
          if (me) {
            console.log(`Logged in as: ${me.name || me.id}`);
          }

          await flushCreds();
          sock.end(undefined);
          process.exit(0);
        } catch (err) {
          await flushCreds();
          sock.end(undefined);

          if (err instanceof ConnectionError) {
            // 401: Session revoked by WhatsApp — clear stale auth and start fresh
            if (err.statusCode === DisconnectReason.loggedOut) {
              console.log("\nSession expired. Clearing old credentials...");
              rmSync(AUTH_DIR, { recursive: true, force: true });
              console.log("Retrying with fresh login...\n");
              continue;
            }

            // 515: Restart required — normal after initial pairing
            if (err.statusCode === DisconnectReason.restartRequired) {
              console.log("Reconnecting after pairing...");
              continue;
            }
          }

          // Any other error — bail
          console.error("Login failed:", (err as Error).message);
          process.exit(EXIT_CONNECTION_FAILED);
        }
      }

      console.error("Login failed after multiple attempts.");
      process.exit(EXIT_CONNECTION_FAILED);
    });

  program
    .command("logout")
    .description("Clear WhatsApp session")
    .action(() => {
      if (existsSync(AUTH_DIR)) {
        rmSync(AUTH_DIR, { recursive: true, force: true });
        console.log("Session cleared. Run `wu login` to re-authenticate.");
      } else {
        console.log("No session found.");
        process.exit(EXIT_NOT_AUTHENTICATED);
      }
    });
}
