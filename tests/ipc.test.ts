import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "net";
import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { WASocket } from "@whiskeysockets/baileys";
import type { WuConfig } from "../src/config/schema.js";
import {
  startDaemonIpc,
  daemonRequest,
  daemonIpcAvailable,
} from "../src/core/ipc.js";

// Short unique path — unix sockets have a ~104 char limit on macOS.
const SOCK = join(tmpdir(), `wu-ipc-${process.pid}.sock`);

describe("daemon IPC transport", () => {
  let stop: () => void;

  before(() => {
    // No live socket — exercises the request/response framing and the
    // "not connected" path without needing WhatsApp.
    stop = startDaemonIpc(() => undefined as unknown as WASocket, {} as WuConfig, SOCK);
  });

  after(() => stop());

  it("reports availability when listening", async () => {
    assert.equal(await daemonIpcAvailable(1000, SOCK), true);
  });

  it("answers ping without a socket", async () => {
    const res = await daemonRequest<{ pong: boolean }>("ping", {}, 5000, SOCK);
    assert.deepEqual(res, { pong: true });
  });

  it("rejects media calls when the daemon has no socket", async () => {
    await assert.rejects(
      () => daemonRequest("media.download", { msgId: "abc" }, 5000, SOCK),
      /not connected/i
    );
  });

  it("rejects unknown methods", async () => {
    await assert.rejects(
      () => daemonRequest("does.not.exist", {}, 5000, SOCK),
      /Unknown IPC method/
    );
  });
});

describe("daemon IPC availability", () => {
  it("is false when nothing is listening", async () => {
    const missing = join(tmpdir(), `wu-ipc-missing-${process.pid}.sock`);
    assert.equal(await daemonIpcAvailable(500, missing), false);
  });
});

describe("daemon IPC client close handling", () => {
  const DEAD_SOCK = join(tmpdir(), `wu-ipc-dead-${process.pid}.sock`);
  let deadServer: Server;

  before(async () => {
    if (existsSync(DEAD_SOCK)) {
      try { unlinkSync(DEAD_SOCK); } catch { /* best effort */ }
    }
    deadServer = createServer((conn) => {
      // Accept the connection, let the client's request land, then hang up
      // without ever writing a response - simulates a daemon that dies
      // mid-request. Destroying only after "data" avoids a write-side EPIPE
      // race that would mask the close path this test targets.
      conn.once("data", () => conn.destroy());
    });
    await new Promise<void>((resolve) => deadServer.listen(DEAD_SOCK, resolve));
  });

  after(async () => {
    await new Promise<void>((resolve) => deadServer.close(() => resolve()));
    try { if (existsSync(DEAD_SOCK)) unlinkSync(DEAD_SOCK); } catch { /* best effort */ }
  });

  it("rejects quickly when the daemon closes without responding", async () => {
    const start = Date.now();
    await assert.rejects(
      () => daemonRequest("ping", {}, 300_000, DEAD_SOCK),
      /closed the connection/
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 5000, `expected fast rejection, took ${elapsed}ms`);
  });
});
