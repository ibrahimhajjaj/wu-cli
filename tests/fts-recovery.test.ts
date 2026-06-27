import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// The message write path runs through the messages_fts AFTER INSERT trigger; a
// corrupt index makes that trigger throw and (in the daemon) the throw is
// swallowed, silently stopping ingestion. withFtsRecovery rebuilds the index
// and retries so a transient corruption self-heals. We can't cheaply produce
// real FTS corruption (SQLite forbids writing the shadow tables), so we drive
// the recovery with synthetic malformed errors against a real FTS-backed DB.
// The rebuild and retry, and the health counters, are what we own and verify.

// Point the singleton DB at a throwaway home before importing the store, so the
// real schema (FTS table + triggers) backs the rebuild step.
const home = mkdtempSync(join(tmpdir(), "wu-fts-"));
process.env.WU_HOME = home;
mkdirSync(join(home, "auth"), { recursive: true });

let store: typeof import("../src/core/store.js");
let database: typeof import("../src/db/database.js");

before(async () => {
  database = await import("../src/db/database.js");
  store = await import("../src/core/store.js");
  // Touch the DB so the schema (including FTS) is created.
  database.getDb();
});

after(() => {
  database.closeDb();
  rmSync(home, { recursive: true, force: true });
});

function malformed(): Error {
  return new Error("database disk image is malformed");
}

describe("withFtsRecovery", () => {
  it("rebuilds and retries on a malformed error, then succeeds", () => {
    const before = store.getStoreHealth().fts_rebuilds;
    let calls = 0;
    const result = store.withFtsRecovery(() => {
      calls++;
      if (calls === 1) throw malformed();
      return "ok";
    });
    assert.equal(result, "ok");
    assert.equal(calls, 2, "should retry exactly once after rebuild");
    assert.equal(
      store.getStoreHealth().fts_rebuilds,
      before + 1,
      "rebuild counter should advance"
    );
    assert.equal(store.getStoreHealth().last_store_error, null);
  });

  it("does not rebuild on an unrelated error, rethrows immediately", () => {
    const before = store.getStoreHealth().fts_rebuilds;
    let calls = 0;
    assert.throws(
      () =>
        store.withFtsRecovery(() => {
          calls++;
          throw new Error("UNIQUE constraint failed");
        }),
      /UNIQUE constraint/
    );
    assert.equal(calls, 1, "should not retry a non-corruption error");
    assert.equal(store.getStoreHealth().fts_rebuilds, before);
  });

  it("records the error when a write still fails after rebuild", () => {
    assert.throws(
      () =>
        store.withFtsRecovery(() => {
          throw malformed();
        }),
      /malformed/
    );
    const health = store.getStoreHealth();
    assert.ok(health.last_store_error_at != null, "error timestamp recorded");
    assert.match(health.last_store_error ?? "", /malformed/);
  });

  it("persists a message end-to-end through the recovery wrapper", () => {
    store.upsertMessage({
      id: "m1",
      chat_jid: "123@g.us",
      sender_jid: "9@s.whatsapp.net",
      sender_name: "Tester",
      body: "hello recovery",
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
      timestamp: 1782291384,
      raw: "{}",
    });
    const hit = store.searchMessages("recovery");
    assert.ok(hit.some((m) => m.id === "m1"), "row is stored and searchable");
  });
});
