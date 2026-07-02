// Minimal stand-in for @modelcontextprotocol/sdk's McpServer, capturing every
// `.tool(name, description, schema, handler)` registration so tests can
// assert on the registered set and invoke handlers directly without a real
// MCP transport.

export interface RegisteredTool {
  name: string;
  desc: string;
  schema: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (...args: any[]) => any;
}

export interface FakeMcp {
  server: unknown;
  tools: Map<string, RegisteredTool>;
}

export function makeFakeMcp(): FakeMcp {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tool: (name: string, desc: string, schema: unknown, handler: (...args: any[]) => any) => {
      tools.set(name, { name, desc, schema, handler });
    },
    resource: () => {},
  };
  return { server, tools };
}
