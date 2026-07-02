import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Same singleton-DB / singleton-config redirection pattern as
// tests/mcp-tools.test.ts: point WU_HOME at a throwaway dir before
// dynamically importing anything that touches the store.
const home = mkdtempSync(join(tmpdir(), "wu-service-"));
process.env.WU_HOME = home;
mkdirSync(join(home, "auth"), { recursive: true });

let store: typeof import("../src/core/store.js");
let database: typeof import("../src/db/database.js");
let service: typeof import("../src/core/service.js");
let schema: typeof import("../src/config/schema.js");

before(async () => {
  database = await import("../src/db/database.js");
  store = await import("../src/core/store.js");
  service = await import("../src/core/service.js");
  schema = await import("../src/config/schema.js");
  database.getDb();

  // Constraint tiers under test:
  //  - exact-allow@g.us  -> exact override, mode "read" (visible)
  //  - exact-deny@g.us   -> exact override, mode "none" (blocked)
  //  - wild1@wild.net    -> matches "*@wild.net" wildcard, mode "read" (visible)
  //  - wilddeny1@denied.net -> matches "*@denied.net" wildcard, mode "none" (blocked)
  //  - default1@s.whatsapp.net / default2@s.whatsapp.net -> no override, falls to default "full" (visible)
  schema.saveConfig(
    schema.WuConfigSchema.parse({
      constraints: {
        default: "full",
        chats: {
          "exact-allow@g.us": { mode: "read" },
          "exact-deny@g.us": { mode: "none" },
          "*@wild.net": { mode: "read" },
          "*@denied.net": { mode: "none" },
        },
      },
    })
  );

  const chats: Array<Parameters<typeof store.upsertChat>[0]> = [
    { jid: "exact-allow@g.us", name: "Exact Allow", type: "group", participant_count: 2, description: null, last_message_at: 1700000010 },
    { jid: "exact-deny@g.us", name: "Exact Deny", type: "group", participant_count: 2, description: null, last_message_at: 1700000020 },
    { jid: "wild1@wild.net", name: "Wild Allow", type: "group", participant_count: 2, description: null, last_message_at: 1700000030 },
    { jid: "wilddeny1@denied.net", name: "Wild Deny", type: "group", participant_count: 2, description: null, last_message_at: 1700000040 },
    { jid: "default1@s.whatsapp.net", name: "Default Visible One", type: "dm", participant_count: null, description: null, last_message_at: 1700000050 },
    { jid: "default2@s.whatsapp.net", name: "Default Visible Two", type: "dm", participant_count: null, description: null, last_message_at: 1700000060 },
  ];
  for (const c of chats) store.upsertChat(c);

  // A community with two subgroups, for listCommunitiesForConfig.
  store.upsertChat({ jid: "community@g.us", name: "Community", type: "group", participant_count: 10, description: null, last_message_at: 1700000100, is_community: 1 });
  store.upsertChat({ jid: "sub-a@g.us", name: "Sub A", type: "group", participant_count: 3, description: null, last_message_at: 1700000090, is_community: 0, linked_parent: "community@g.us" });
  store.upsertChat({ jid: "sub-b@g.us", name: "Sub B", type: "group", participant_count: 3, description: null, last_message_at: 1700000080, is_community: 0, linked_parent: "community@g.us" });

  // Messages for listMessagesForConfig / searchMessagesForConfig.
  const baseMsg = {
    sender_jid: "sender@s.whatsapp.net",
    sender_name: "Sender",
    type: "text",
    media_mime: null, media_path: null, media_size: null, media_direct_path: null,
    media_key: null, media_file_sha256: null, media_file_enc_sha256: null, media_file_length: null,
    quoted_id: null, location_lat: null, location_lon: null, location_name: null,
    is_from_me: 0, raw: "{}",
  };
  store.upsertMessage({ ...baseMsg, id: "msg-allowed", chat_jid: "exact-allow@g.us", body: "visible needle here", timestamp: 1700000011 });
  store.upsertMessage({ ...baseMsg, id: "msg-blocked", chat_jid: "exact-deny@g.us", body: "blocked needle here", timestamp: 1700000021 });
  store.upsertMessage({ ...baseMsg, id: "msg-default", chat_jid: "default1@s.whatsapp.net", body: "default needle here", timestamp: 1700000051 });
});

after(() => {
  database.closeDb();
  rmSync(home, { recursive: true, force: true });
});

function config() {
  return schema.loadConfig();
}

describe("listChatsForConfig", () => {
  it("applies exact, wildcard, and default constraint tiers", () => {
    const jids = service.listChatsForConfig(config(), { limit: 100 }).map((c) => c.jid);
    assert.ok(jids.includes("exact-allow@g.us"), "exact-allow should be visible");
    assert.ok(!jids.includes("exact-deny@g.us"), "exact-deny should be blocked");
    assert.ok(jids.includes("wild1@wild.net"), "wildcard-allow should be visible");
    assert.ok(!jids.includes("wilddeny1@denied.net"), "wildcard-deny should be blocked");
    assert.ok(jids.includes("default1@s.whatsapp.net"), "default-mode chat should be visible");
  });

  it("respects limit without over-fetching semantics (returns exactly `limit` rows when more are visible)", () => {
    const rows = service.listChatsForConfig(config(), { limit: 2 });
    assert.equal(rows.length, 2);
  });

  it("returns nothing when there is no constraints block at all", () => {
    const bare = schema.WuConfigSchema.parse({});
    const rows = service.listChatsForConfig(bare, { limit: 100 });
    assert.equal(rows.length, 0);
  });
});

describe("searchChatsForConfig", () => {
  it("filters by name and by constraint together", () => {
    const rows = service.searchChatsForConfig(config(), "Exact", { limit: 100 });
    const jids = rows.map((r) => r.jid);
    assert.ok(jids.includes("exact-allow@g.us"));
    assert.ok(!jids.includes("exact-deny@g.us"));
  });
});

describe("listDmsForConfig", () => {
  it("only returns type=dm rows, constraint-filtered by default", () => {
    const rows = service.listDmsForConfig(config(), { limit: 100 });
    assert.ok(rows.every((r) => r.type === "dm"));
    assert.ok(rows.some((r) => r.jid === "default1@s.whatsapp.net"));
  });

  it("includeBlocked bypasses the constraint filter but still restricts to dms", () => {
    // Add a dm that resolves to "none" via the wildcard-deny domain.
    store.upsertChat({ jid: "x@denied.net", name: "Blocked DM", type: "dm", participant_count: null, description: null, last_message_at: 1700000099 });
    const allDms = service.listDmsForConfig(config(), { limit: 100, includeBlocked: true });
    const visibleDms = service.listDmsForConfig(config(), { limit: 100, includeBlocked: false });
    assert.ok(allDms.some((r) => r.jid === "x@denied.net"));
    assert.ok(!visibleDms.some((r) => r.jid === "x@denied.net"));
  });
});

describe("listGroupsForConfig", () => {
  it("allowedOnly filters out constraint-blocked groups; default shows all groups", () => {
    const all = service.listGroupsForConfig(config(), { limit: 100 });
    const allowedOnly = service.listGroupsForConfig(config(), { limit: 100, allowedOnly: true });
    assert.ok(all.some((g) => g.jid === "exact-deny@g.us"));
    assert.ok(!allowedOnly.some((g) => g.jid === "exact-deny@g.us"));
    assert.ok(allowedOnly.some((g) => g.jid === "exact-allow@g.us"));
  });

  it("order: recency sorts by last_message_at desc, name sorts alphabetically", () => {
    const byRecency = service.listGroupsForConfig(config(), { limit: 100, order: "recency" }).map((g) => g.jid);
    const byName = service.listGroupsForConfig(config(), { limit: 100, order: "name" }).map((g) => g.jid);
    // Highest last_message_at among groups is community@g.us (1700000070).
    assert.equal(byRecency[0], "community@g.us");
    // Alphabetical by name: "Community" < "Exact Allow" < "Exact Deny" < ...
    assert.equal(byName[0], "community@g.us"); // name "Community"
  });
});

describe("getChat", () => {
  it("returns the row for a known jid and undefined for an unknown one", () => {
    assert.equal(service.getChat("exact-allow@g.us")?.name, "Exact Allow");
    assert.equal(service.getChat("nope@g.us"), undefined);
  });
});

describe("listCommunitiesForConfig", () => {
  it("returns parents and, when requested, their subgroups keyed by linked_parent", () => {
    const { parents, childrenByParent } = service.listCommunitiesForConfig(config(), {
      limit: 100,
      withSubgroups: true,
    });
    assert.ok(parents.some((p) => p.jid === "community@g.us"));
    const kids = childrenByParent.get("community@g.us") || [];
    assert.equal(kids.length, 2);
    assert.deepEqual(kids.map((k) => k.jid).sort(), ["sub-a@g.us", "sub-b@g.us"]);
  });

  it("omits children when withSubgroups is false", () => {
    const { childrenByParent } = service.listCommunitiesForConfig(config(), { limit: 100 });
    assert.equal(childrenByParent.size, 0);
  });
});

describe("listMessagesForConfig", () => {
  it("returns null for a chat blocked by constraints", () => {
    assert.equal(
      service.listMessagesForConfig(config(), { chatJid: "exact-deny@g.us" }),
      null
    );
  });

  it("returns rows for a visible chat", () => {
    const rows = service.listMessagesForConfig(config(), { chatJid: "exact-allow@g.us" });
    assert.ok(Array.isArray(rows));
    assert.equal(rows!.length, 1);
    assert.equal(rows![0].id, "msg-allowed");
  });
});

describe("searchMessagesForConfig", () => {
  it("only returns matches from chats visible under the constraint config", () => {
    const results = service.searchMessagesForConfig(config(), "needle", { limit: 100 });
    const ids = results.map((r) => r.id);
    assert.ok(ids.includes("msg-allowed"));
    assert.ok(ids.includes("msg-default"));
    assert.ok(!ids.includes("msg-blocked"), "message in a constraint-blocked chat must not appear");
  });

  it("respects limit", () => {
    const results = service.searchMessagesForConfig(config(), "needle", { limit: 1 });
    assert.equal(results.length, 1);
  });
});
