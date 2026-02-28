import { createRequire } from "node:module";
import { existsSync } from "fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json");
import type { WASocket } from "@whiskeysockets/baileys";
import { createConnection, waitForConnection } from "../core/connection.js";
import { startListener } from "../core/listener.js";
import { isLocked, acquireLock, releaseLock } from "../core/lock.js";
import { loadConfig } from "../config/schema.js";
import { DB_PATH } from "../config/paths.js";
import { closeDb } from "../db/database.js";
import { getDefaultRemote, checkRemoteHealth } from "../core/remote.js";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";

export async function startMcpServer(): Promise<void> {
  const config = loadConfig();

  const server = new McpServer({
    name: "wu-cli",
    version,
  });

  let sock: WASocket | undefined;
  let flushCreds: (() => Promise<void>) | undefined;
  let ownsConnection = false;

  const getSock = (): WASocket | undefined => sock;

  const { locked } = isLocked();
  const defaultRemote = getDefaultRemote(config);
  const hasLocalDb = existsSync(DB_PATH);

  // Determine remote for tools (undefined = local mode)
  let remoteForTools: { name: string; remote: import("../config/schema.js").RemoteConfig } | undefined;

  if (locked) {
    // Mode 1: daemon running locally — read-only from SQLite (existing behavior)
    process.stderr.write("wu-mcp: Daemon is running, starting in read-only mode (queries only, no sending)\n");
  } else if (defaultRemote && hasLocalDb) {
    // Mode 3: remote mode — reads local, writes via SSH
    remoteForTools = defaultRemote;
    const health = await checkRemoteHealth(defaultRemote.remote);
    if (!health.daemonRunning) {
      process.stderr.write("wu-mcp: Warning — remote daemon not running, writes will fail\n");
    }
    process.stderr.write(`wu-mcp: Remote mode (${defaultRemote.name}) — local reads, SSH writes\n`);
  } else if (defaultRemote && !hasLocalDb) {
    process.stderr.write("wu-mcp: Remote configured but no local DB. Run 'wu sync pull' first.\n");
    process.exit(1);
  } else {
    // Mode 2: full local — acquire lock, connect to WhatsApp (existing behavior)
    acquireLock();
    ownsConnection = true;

    const conn = await createConnection({
      quiet: true,
      onOpen: () => {
        process.stderr.write("wu-mcp: Connected to WhatsApp\n");
      },
    });

    sock = conn.sock;
    flushCreds = conn.flushCreds;

    await waitForConnection(sock);

    // Start listener for message collection
    startListener(sock, { config, quiet: true });
  }

  // Register tools and resources
  registerTools(server, getSock, config, remoteForTools);
  registerResources(server);

  // Graceful shutdown
  const shutdown = async () => {
    process.stderr.write("wu-mcp: Shutting down...\n");
    if (flushCreds) await flushCreds();
    if (sock) sock.end(undefined);
    closeDb();
    if (ownsConnection) releaseLock();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start MCP transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("wu-mcp: MCP server ready — tools available for AI agents\n");
}
