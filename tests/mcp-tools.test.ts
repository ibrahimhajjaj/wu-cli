import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { makeFakeSocket } from "./helpers/fake-socket.js";
import { makeFakeMcp } from "./helpers/fake-mcp.js";

// Same singleton-DB / singleton-config redirection pattern as the other
// daemon-runtime test files: point WU_HOME at a throwaway dir before
// dynamically importing anything that touches the store or config.
const home = mkdtempSync(join(tmpdir(), "wu-mcp-tools-"));
process.env.WU_HOME = home;
mkdirSync(join(home, "auth"), { recursive: true });

let store: typeof import("../src/core/store.js");
let database: typeof import("../src/db/database.js");
let toolsMod: typeof import("../src/mcp/tools.js");
let schema: typeof import("../src/config/schema.js");

before(async () => {
  database = await import("../src/db/database.js");
  store = await import("../src/core/store.js");
  toolsMod = await import("../src/mcp/tools.js");
  schema = await import("../src/config/schema.js");
  database.getDb();

  // wu_chats_list / wu_messages_list / etc. gate reads through `loadConfig()`
  // read fresh off disk on every call - not the `config` object passed into
  // registerTools. Write an on-disk config that allows reads so the "read
  // tool returns data" assertions below have something to see.
  schema.saveConfig(schema.WuConfigSchema.parse({ constraints: { default: "full" } }));

  store.upsertChat({
    jid: "team@g.us",
    name: "Team Chat",
    type: "group",
    participant_count: 3,
    description: null,
    last_message_at: 1700000000,
  });
  store.upsertMessage({
    id: "seed-1",
    chat_jid: "team@g.us",
    sender_jid: "111@s.whatsapp.net",
    sender_name: "Alice",
    body: "hello team",
    type: "text",
    media_mime: null,
    media_path: null,
    media_size: null,
    media_direct_path: null,
    media_key: null,
    media_file_sha256: null,
    media_file_enc_sha256: null,
    media_file_length: null,
    quoted_id: null,
    location_lat: null,
    location_lon: null,
    location_name: null,
    is_from_me: 0,
    timestamp: 1700000000,
    raw: "{}",
  });
});

after(() => {
  database.closeDb();
  rmSync(home, { recursive: true, force: true });
});

function config() {
  return schema.WuConfigSchema.parse({ constraints: { default: "full" } });
}

// Ground truth for "how many tools exist" instead of hardcoding a number:
// count the actual `server.tool(` call sites in the source under test.
function toolCallSiteCount(): number {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "src", "mcp", "tools.ts"), "utf-8");
  return (src.match(/server\.tool\(/g) || []).length;
}

describe("registerTools - registration", () => {
  it("registers one fewer tool than the source's call-site count when no remote is configured (wu_sync_pull is remote-only)", () => {
    const { sock } = makeFakeSocket();
    const { server, tools } = makeFakeMcp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toolsMod.registerTools(server as any, () => sock, config());

    assert.equal(tools.size, toolCallSiteCount() - 1);
    assert.equal(tools.has("wu_sync_pull"), false);
  });

  it("registers wu_sync_pull too when a remote is configured, matching the full call-site count", () => {
    const { sock } = makeFakeSocket();
    const { server, tools } = makeFakeMcp();
    const remote = {
      name: "vps",
      remote: { host: "example.com", wu_home: "~/.wu" },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toolsMod.registerTools(server as any, () => sock, config(), remote);

    assert.equal(tools.size, toolCallSiteCount());
    assert.equal(tools.has("wu_sync_pull"), true);
  });

  it("every registered tool has a non-empty description and a schema", () => {
    const { sock } = makeFakeSocket();
    const { server, tools } = makeFakeMcp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toolsMod.registerTools(server as any, () => sock, config());

    assert.ok(tools.size > 0);
    for (const [name, tool] of tools) {
      assert.ok(typeof tool.desc === "string" && tool.desc.length > 0, `${name} missing a description`);
      assert.ok(tool.schema && typeof tool.schema === "object", `${name} missing a schema object`);
    }
  });
});

describe("registerTools - read-tool routing", () => {
  it("wu_chats_list returns stored data and never touches the socket", async () => {
    const { sock, calls } = makeFakeSocket();
    const { server, tools } = makeFakeMcp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toolsMod.registerTools(server as any, () => sock, config());

    const tool = tools.get("wu_chats_list");
    assert.ok(tool);
    const result = await tool!.handler({ limit: 100 });
    const parsed = JSON.parse(result.content[0].text);

    assert.ok(Array.isArray(parsed));
    assert.ok(parsed.some((c: { jid: string }) => c.jid === "team@g.us"));
    assert.equal(calls.length, 0, "a read tool must not invoke any socket method");
  });

  it("wu_messages_list returns the seeded message for an allowed chat", async () => {
    const { sock, calls } = makeFakeSocket();
    const { server, tools } = makeFakeMcp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toolsMod.registerTools(server as any, () => sock, config());

    const tool = tools.get("wu_messages_list");
    const result = await tool!.handler({ chat: "team@g.us", limit: 50 });
    const parsed = JSON.parse(result.content[0].text);

    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].id, "seed-1");
    assert.equal(parsed[0].body, "hello team");
    assert.equal(calls.length, 0);
  });

  it("wu_messages_list refuses a chat blocked by constraints without touching the socket", async () => {
    const { sock, calls } = makeFakeSocket();
    const { server, tools } = makeFakeMcp();
    // wu_messages_list gates via loadConfig() read fresh off disk (not the
    // `config` object passed to registerTools), so the on-disk file has to
    // reflect the block for this assertion to exercise the real gate.
    const cfg = schema.WuConfigSchema.parse({
      constraints: { default: "full", chats: { "blocked@g.us": { mode: "none" } } },
    });
    schema.saveConfig(cfg);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toolsMod.registerTools(server as any, () => sock, cfg);

    try {
      const tool = tools.get("wu_messages_list");
      const result = await tool!.handler({ chat: "blocked@g.us", limit: 50 });

      assert.equal(result.isError, true);
      assert.match(JSON.parse(result.content[0].text).error, /blocked by constraints/);
      assert.equal(calls.length, 0);
    } finally {
      // Restore the permissive default the rest of this file relies on.
      schema.saveConfig(config());
    }
  });
});

describe("registerTools - write-tool validation", () => {
  it("wu_messages_send without message or media_path returns an error, does not call sendMessage", async () => {
    const { sock, calls } = makeFakeSocket();
    const { server, tools } = makeFakeMcp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toolsMod.registerTools(server as any, () => sock, config());

    const tool = tools.get("wu_messages_send");
    const result = await tool!.handler({ to: "123@g.us" });

    assert.equal(result.isError, true);
    assert.equal(calls.length, 0);
  });

  it("a media batch download with concurrency 0 does not throw out of the handler", async () => {
    const { sock, calls } = makeFakeSocket();
    const { server, tools } = makeFakeMcp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toolsMod.registerTools(server as any, () => sock, config());

    const tool = tools.get("wu_media_download_batch");
    // concurrency: 0 is clamped to 1 by asyncPool, so the batch still runs
    // its single worker instead of leaving the result array unpopulated.
    // The seeded message has no downloadable content, so that worker
    // records a per-item failure rather than throwing out of the handler.
    const result = await tool!.handler({ message_ids: ["seed-1"], concurrency: 0 });
    const parsed = JSON.parse(result.content[0].text);

    assert.equal(result.isError, undefined, "the handler call itself should not error");
    assert.equal(parsed.results.length, 0);
    assert.equal(parsed.errors.length, 1);
    assert.equal(parsed.errors[0].msgId, "seed-1");
    assert.equal(calls.length, 0);
  });
});

describe("registerTools - constraints round trip through the on-disk config", () => {
  it("wu_constraints_default writes and wu_config_show reads it back", async () => {
    const { sock } = makeFakeSocket();
    const { server, tools } = makeFakeMcp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toolsMod.registerTools(server as any, () => sock, config());

    const setTool = tools.get("wu_constraints_default");
    const setResult = await setTool!.handler({ mode: "read" });
    assert.deepEqual(JSON.parse(setResult.content[0].text), { default: "read" });

    const showTool = tools.get("wu_config_show");
    const showResult = await showTool!.handler({});
    const cfg = JSON.parse(showResult.content[0].text);
    assert.equal(cfg.constraints.default, "read");

    // Restore "full" so it doesn't leak into later tests in this file.
    await setTool!.handler({ mode: "full" });
  });
});
