import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { WASocket } from "@whiskeysockets/baileys";
import { createConnection, waitForConnection } from "../core/connection.js";
import { startListener } from "../core/listener.js";
import { acquireLock, releaseLock } from "../core/lock.js";
import { loadConfig } from "../config/schema.js";
import { closeDb } from "../db/database.js";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";

export async function startMcpServer(): Promise<void> {
  // Acquire lock — conflicts with daemon/listen
  acquireLock();

  const config = loadConfig();

  const server = new McpServer({
    name: "wu-cli",
    version: "0.1.0",
  });

  let sock: WASocket | undefined;
  let flushCreds: (() => Promise<void>) | undefined;

  const getSock = (): WASocket | undefined => sock;

  // Register tools and resources
  registerTools(server, getSock, config);
  registerResources(server);

  // Connect to WhatsApp
  const conn = await createConnection({
    onOpen: () => {
      // stderr only — stdout is MCP protocol
      process.stderr.write("wu-mcp: Connected to WhatsApp\n");
    },
  });

  sock = conn.sock;
  flushCreds = conn.flushCreds;

  await waitForConnection(sock);

  // Start listener for message collection
  startListener(sock, { config });

  // Graceful shutdown
  const shutdown = async () => {
    process.stderr.write("wu-mcp: Shutting down...\n");
    if (flushCreds) await flushCreds();
    if (sock) sock.end(undefined);
    closeDb();
    releaseLock();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start MCP transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
