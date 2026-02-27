import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json");
import type { WASocket } from "@whiskeysockets/baileys";
import { createConnection, waitForConnection } from "../core/connection.js";
import { startListener } from "../core/listener.js";
import { isLocked, acquireLock, releaseLock } from "../core/lock.js";
import { loadConfig } from "../config/schema.js";
import { closeDb } from "../db/database.js";
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

  // Register tools and resources
  registerTools(server, getSock, config);
  registerResources(server);

  const { locked } = isLocked();

  if (locked) {
    // Daemon is running — serve read-only from SQLite, no connection
    process.stderr.write("wu-mcp: Daemon is running, starting in read-only mode (queries only, no sending)\n");
  } else {
    // No daemon — acquire lock and connect
    acquireLock();
    ownsConnection = true;

    const conn = await createConnection({
      onOpen: () => {
        process.stderr.write("wu-mcp: Connected to WhatsApp\n");
      },
    });

    sock = conn.sock;
    flushCreds = conn.flushCreds;

    await waitForConnection(sock);

    // Start listener for message collection
    startListener(sock, { config });
  }

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
}
