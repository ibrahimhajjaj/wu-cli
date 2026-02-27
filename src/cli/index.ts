#!/usr/bin/env node

import { createRequire } from "node:module";
import { Command } from "commander";
import { ensureWuHome } from "../config/paths.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json");
import { registerConfigCommand } from "./config.js";
import { registerLoginCommand } from "./login.js";
import { registerStatusCommand } from "./status.js";
import { registerChatsCommand } from "./chats.js";
import { registerMessagesCommand } from "./messages.js";
import { registerContactsCommand } from "./contacts.js";
import { registerGroupsCommand } from "./groups.js";
import { registerMediaCommand } from "./media.js";
import { registerListenCommand } from "./listen.js";
import { registerDaemonCommand } from "./daemon.js";
import { registerDbCommand } from "./db.js";
import { registerMcpCommand } from "./mcp.js";
import { EXIT_GENERAL_ERROR } from "./exit-codes.js";

const program = new Command();

program
  .name("wu")
  .description("WhatsApp CLI — like gh is to GitHub, wu is to WhatsApp")
  .version(version)
  .exitOverride();

ensureWuHome();

registerConfigCommand(program);
registerLoginCommand(program);
registerStatusCommand(program);
registerChatsCommand(program);
registerMessagesCommand(program);
registerContactsCommand(program);
registerGroupsCommand(program);
registerMediaCommand(program);
registerListenCommand(program);
registerDaemonCommand(program);
registerDbCommand(program);
registerMcpCommand(program);

try {
  await program.parseAsync(process.argv);
} catch (err: unknown) {
  if (
    err &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code: string }).code === "commander.helpDisplayed"
  ) {
    process.exit(0);
  }
  if (
    err &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code: string }).code === "commander.version"
  ) {
    process.exit(0);
  }
  // Commander exit override errors
  if (
    err &&
    typeof err === "object" &&
    "exitCode" in err
  ) {
    process.exit((err as { exitCode: number }).exitCode);
  }
  console.error(err);
  process.exit(EXIT_GENERAL_ERROR);
}
