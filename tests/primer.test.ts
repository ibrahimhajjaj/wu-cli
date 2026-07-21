import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Redirect WU_HOME before importing anything that freezes paths from it.
const home = mkdtempSync(join(tmpdir(), "wu-primer-"));
process.env.WU_HOME = home;
mkdirSync(join(home, "auth"), { recursive: true });

let store: typeof import("../src/core/store.js");
let database: typeof import("../src/db/database.js");
let primer: typeof import("../src/core/primer.js");
let schema: typeof import("../src/config/schema.js");

before(async () => {
  database = await import("../src/db/database.js");
  store = await import("../src/core/store.js");
  primer = await import("../src/core/primer.js");
  schema = await import("../src/config/schema.js");
  database.getDb();
});

after(() => {
  database.closeDb();
  rmSync(home, { recursive: true, force: true });
});

function chat(jid: string, type: string, lastMessageAt: number | null) {
  store.upsertChat({
    jid,
    name: jid,
    type,
    participant_count: null,
    description: null,
    last_message_at: lastMessageAt,
  });
}

function seedMessage(jid: string, id: string, ts: number) {
  store.upsertMessage({
    id,
    chat_jid: jid,
    sender_jid: "111@s.whatsapp.net",
    sender_name: "Alice",
    body: "hi",
    type: "text",
    media_mime: null, media_path: null, media_size: null,
    media_direct_path: null, media_key: null, media_file_sha256: null,
    media_file_enc_sha256: null, media_file_length: null,
    quoted_id: null, location_lat: null, location_lon: null, location_name: null,
    is_from_me: 0, timestamp: ts, raw: "{}",
  });
}

const NOW = 2_000_000_000;

describe("computePrimePending", () => {
  it("enrolls allowed groups with no messages, excludes collected / blocked / non-group", () => {
    chat("allowed-empty@g.us", "group", NOW - 3600); // allowed, 0 msgs -> pending
    chat("allowed-collected@g.us", "group", NOW - 3600); // allowed but has a msg
    seedMessage("allowed-collected@g.us", "c1", NOW - 3600);
    chat("blocked-empty@g.us", "group", NOW - 3600); // 0 msgs but not allowed
    chat("allowed-dm@s.whatsapp.net", "dm", NOW - 3600); // allowed, 0 msgs, but a DM

    const config = schema.WuConfigSchema.parse({
      constraints: {
        default: "none",
        chats: {
          "allowed-empty@g.us": { mode: "read" },
          "allowed-collected@g.us": { mode: "read" },
          "allowed-dm@s.whatsapp.net": { mode: "read" },
        },
      },
    });

    const pending = primer.computePrimePending(config, NOW);
    assert.ok(pending.has("allowed-empty@g.us"), "allowed empty group is pending");
    assert.equal(pending.get("allowed-empty@g.us"), NOW, "stamped with enrolled-at");
    assert.ok(!pending.has("allowed-collected@g.us"), "a collected group is not pending");
    assert.ok(!pending.has("blocked-empty@g.us"), "a blocked group is not pending");
    assert.ok(!pending.has("allowed-dm@s.whatsapp.net"), "priming is group-only");
  });
});

describe("findSilentGaps", () => {
  it("flags only post-enrollment activity that stored nothing, past the grace window", () => {
    const ENROLLED = NOW - 3600; // all enrolled 1h ago
    chat("gap@g.us", "group", NOW - 1800); // activity 30min ago (after enroll, past grace) -> gap
    chat("preallow@g.us", "group", NOW - 7200); // activity 2h ago (before enroll) -> not a failure
    chat("fresh@g.us", "group", NOW - 60); // activity 1min ago (within grace) -> too fresh
    chat("stale@g.us", "group", NOW - 8 * 24 * 3600); // outside the 7d window
    chat("collected@g.us", "group", NOW - 1800); // post-enroll activity but has a message
    seedMessage("collected@g.us", "g1", NOW - 1800);

    // primePending encodes allowed + group-only + not-yet-collected; only these
    // jids are candidates. A non-enrolled message-less chat is never flagged.
    chat("not-enrolled@g.us", "group", NOW - 1800);
    const primePending = new Map<string, number>([
      ["gap@g.us", ENROLLED],
      ["preallow@g.us", ENROLLED],
      ["fresh@g.us", ENROLLED],
      ["stale@g.us", ENROLLED],
      // collected@g.us has a row now, so it would not be in primePending
    ]);

    const gaps = primer.findSilentGaps(primePending, NOW).map((g) => g.jid);
    assert.ok(gaps.includes("gap@g.us"), "post-enrollment activity with 0 stored is flagged");
    assert.ok(!gaps.includes("preallow@g.us"), "pre-allow activity is not a collection failure");
    assert.ok(!gaps.includes("fresh@g.us"), "activity inside the grace window is not flagged");
    assert.ok(!gaps.includes("stale@g.us"), "stale activity is not flagged");
    assert.ok(!gaps.includes("collected@g.us"), "a collecting group is not a gap");
    assert.ok(!gaps.includes("not-enrolled@g.us"), "only enrolled groups are candidates");
  });
});
