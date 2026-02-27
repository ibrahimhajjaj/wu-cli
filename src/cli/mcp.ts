import { Command } from "commander";
import { startMcpServer } from "../mcp/server.js";
import { EXIT_GENERAL_ERROR } from "./exit-codes.js";

export function registerMcpCommand(program: Command): void {
  program
    .command("mcp")
    .description("Start MCP server (stdio transport for AI agents)")
    .action(async () => {
      try {
        await startMcpServer();
      } catch (err) {
        process.stderr.write(`MCP server error: ${(err as Error).message}\n`);
        process.exit(EXIT_GENERAL_ERROR);
      }
    });
}
