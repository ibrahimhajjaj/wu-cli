import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { makeFakeSocket } from "./helpers/fake-socket.js";
import { makeFakeMcp } from "./helpers/fake-mcp.js";

// Same singleton-DB / singleton-config redirection pattern as
// tests/mcp-tools.test.ts.
const home = mkdtempSync(join(tmpdir(), "wu-mcp-dispatch-"));
process.env.WU_HOME = home;
mkdirSync(join(home, "auth"), { recursive: true });

let database: typeof import("../src/db/database.js");
let toolsMod: typeof import("../src/mcp/tools.js");
let schema: typeof import("../src/config/schema.js");

before(async () => {
  database = await import("../src/db/database.js");
  toolsMod = await import("../src/mcp/tools.js");
  schema = await import("../src/config/schema.js");
  database.getDb();
});

after(() => {
  database.closeDb();
  rmSync(home, { recursive: true, force: true });
});

function config() {
  return schema.WuConfigSchema.parse({
    constraints: { default: "full" },
    whatsapp: { send_delay_ms: 0 },
  });
}

// The write/media tools all route through the same dispatch() helper in
// tools.ts: local socket -> (ipc rung, media tools only) -> remote SSH ->
// error. sshWuExec is a hard import in tools.ts (no injection seam - it's a
// transport primitive out of scope for this plan to modify), so the remote
// branch itself isn't exercised here; it's covered by manual verification
// against a configured remote instead. These tests prove the two branches
// that don't need a live remote: the local path, and the "no transport at
// all" error path (including that each tool keeps its own wording there).
describe("dispatch - local path", () => {
  it("wu_messages_send takes the local branch when a socket is live, never touching remoteArgs", async () => {
    const { sock, calls } = makeFakeSocket();
    const { server, tools } = makeFakeMcp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toolsMod.registerTools(server as any, () => sock, config());

    const tool = tools.get("wu_messages_send");
    const result = await tool!.handler({ to: "123@g.us", message: "hi" });
    const parsed = JSON.parse(result.content[0].text);

    assert.equal(result.isError, undefined);
    assert.equal(parsed.id, "fake-msg-id");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "sendMessage");
  });

  it("wu_media_download_batch takes the local branch and never calls the socket's send methods", async () => {
    const { sock, calls } = makeFakeSocket();
    const { server, tools } = makeFakeMcp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toolsMod.registerTools(server as any, () => sock, config());

    const tool = tools.get("wu_media_download_batch");
    // No message_ids and no chat: the local branch resolves this itself and
    // reports the validation error, rather than falling through to ipc/remote.
    const result = await tool!.handler({ concurrency: 4 });

    assert.equal(result.isError, true);
    assert.match(JSON.parse(result.content[0].text).error, /Provide message_ids or chat/);
    assert.equal(calls.length, 0);
  });
});

describe("dispatch - no transport available", () => {
  it("wu_messages_send reports the generic 'not connected' error with no socket and no remote", async () => {
    const { server, tools } = makeFakeMcp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toolsMod.registerTools(server as any, () => undefined, config());

    const tool = tools.get("wu_messages_send");
    const result = await tool!.handler({ to: "123@g.us", message: "hi" });

    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error, "Not connected to WhatsApp and no remote configured");
  });

  it("wu_media_download reports its own 'daemon or remote' wording with no socket, ipc, or remote", async () => {
    const { server, tools } = makeFakeMcp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toolsMod.registerTools(server as any, () => undefined, config());

    const tool = tools.get("wu_media_download");
    const result = await tool!.handler({ message_id: "seed-1" });

    assert.equal(result.isError, true);
    assert.equal(
      JSON.parse(result.content[0].text).error,
      "Not connected to WhatsApp and no daemon or remote available"
    );
  });

  it("wu_media_download_batch reports its own 'requires connection' wording with no socket, ipc, or remote", async () => {
    const { server, tools } = makeFakeMcp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toolsMod.registerTools(server as any, () => undefined, config());

    const tool = tools.get("wu_media_download_batch");
    const result = await tool!.handler({ message_ids: ["seed-1"] });

    assert.equal(result.isError, true);
    assert.equal(
      JSON.parse(result.content[0].text).error,
      "Not connected to WhatsApp (media download requires connection)"
    );
  });

  it("wu_history_backfill reports the generic 'not connected' error with no socket and no remote", async () => {
    const { server, tools } = makeFakeMcp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toolsMod.registerTools(server as any, () => undefined, config());

    const tool = tools.get("wu_history_backfill");
    const result = await tool!.handler({ jid: "123@g.us", count: 10, timeout_ms: 1000 });

    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error, "Not connected to WhatsApp and no remote configured");
  });
});
