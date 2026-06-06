import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
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
