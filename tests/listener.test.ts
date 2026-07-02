import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { WuConfig } from "../src/config/schema.js";

// A message that arrives with no key.id (protocol stub / edge case) must not
// be persisted - SQLite doesn't enforce NOT NULL on a non-integer primary key,
// so a null id would otherwise insert a row with a null PK and a
// "jid:undefined" dedup key. Point the singleton DB at a throwaway home before
// importing, so startListener runs against the real schema.
const home = mkdtempSync(join(tmpdir(), "wu-listener-"));
process.env.WU_HOME = home;
mkdirSync(join(home, "auth"), { recursive: true });

let database: typeof import("../src/db/database.js");
let listener: typeof import("../src/core/listener.js");
let schema: typeof import("../src/config/schema.js");

before(async () => {
  database = await import("../src/db/database.js");
  listener = await import("../src/core/listener.js");
  schema = await import("../src/config/schema.js");
  database.getDb();
});

after(() => {
  database.closeDb();
  rmSync(home, { recursive: true, force: true });
});

function fullAccessConfig(): WuConfig {
  const config = schema.loadConfig();
  config.constraints = { default: "full", chats: {} };
  return config;
}

// Minimal fake WASocket: startListener only touches sock.ev.on, so capture
// handlers by event name and let the test invoke them directly.
function fakeSocket() {
  const handlers = new Map<string, (...args: any[]) => void>();
  const sock = {
    ev: {
      on: (event: string, handler: (...args: any[]) => void) => {
        handlers.set(event, handler);
      },
    },
  };
  return {
    sock: sock as any,
    emit: (event: string, payload: unknown) => handlers.get(event)?.(payload),
  };
}

describe("startListener - message id guard", () => {
  it("skips a message with no key.id (no row, no throw)", () => {
    const { sock, emit } = fakeSocket();
    listener.startListener(sock, { config: fullAccessConfig(), quiet: true });

    assert.doesNotThrow(() => {
      emit("messages.upsert", {
        type: "notify",
        messages: [
          {
            key: { remoteJid: "1234567890@s.whatsapp.net", fromMe: false },
            message: { conversation: "hello, no id" },
            messageTimestamp: 1700000000,
          },
        ],
      });
    });

    const rows = database.getDb().prepare("SELECT * FROM messages").all();
    assert.equal(rows.length, 0, "message with no key.id should not be persisted");
  });

  it("stores a message that does have a key.id (control case)", () => {
    const { sock, emit } = fakeSocket();
    listener.startListener(sock, { config: fullAccessConfig(), quiet: true });

    emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: "1234567890@s.whatsapp.net", id: "ABCD1234", fromMe: false },
          message: { conversation: "hello, with id" },
          messageTimestamp: 1700000001,
        },
      ],
    });

    const row = database
      .getDb()
      .prepare("SELECT * FROM messages WHERE id = ?")
      .get("ABCD1234") as { body: string } | undefined;
    assert.ok(row, "message with key.id should be persisted");
    assert.equal(row?.body, "hello, with id");
  });
});
