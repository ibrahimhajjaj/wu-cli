import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { WASocket } from "@whiskeysockets/baileys";

// Redirect WU_HOME before importing anything that freezes paths from it.
const home = mkdtempSync(join(tmpdir(), "wu-groupmeta-"));
process.env.WU_HOME = home;
mkdirSync(join(home, "auth"), { recursive: true });

let store: typeof import("../src/core/store.js");
let database: typeof import("../src/db/database.js");
let groups: typeof import("../src/core/groups.js");
let schema: typeof import("../src/config/schema.js");

before(async () => {
  database = await import("../src/db/database.js");
  store = await import("../src/core/store.js");
  groups = await import("../src/core/groups.js");
  schema = await import("../src/config/schema.js");
  database.getDb();
});

after(() => {
  database.closeDb();
  rmSync(home, { recursive: true, force: true });
});

// A socket whose only job is to answer the participating-groups fetch.
function socketWithGroups(payload: Record<string, unknown>): WASocket {
  return {
    groupFetchAllParticipating: async () => payload,
  } as unknown as WASocket;
}

describe("refreshGroupMetadata", () => {
  it("fills in metadata a message-created row left null", async () => {
    // Exactly the state a fresh store lands in: the row exists because a message
    // arrived, so it has a timestamp but no group metadata.
    store.upsertChat({
      jid: "repair@g.us",
      name: null,
      type: "group",
      participant_count: null,
      description: null,
      last_message_at: 1700000000,
    });
    const before = store.getChatByJid("repair@g.us");
    assert.equal(before!.participant_count, null, "starts null");

    const config = schema.WuConfigSchema.parse({ constraints: { default: "read" } });
    const result = await groups.refreshGroupMetadata(
      socketWithGroups({
        "repair@g.us": {
          id: "repair@g.us",
          subject: "Repaired Group",
          desc: "now described",
          isCommunity: true,
          isCommunityAnnounce: false,
          linkedParent: "parent@g.us",
          participants: [
            { id: "111@s.whatsapp.net", admin: "superadmin" },
            { id: "222@s.whatsapp.net", admin: null },
          ],
        },
      }),
      config
    );

    assert.equal(result.groups, 1);
    assert.equal(result.rosters, 1);

    const after = store.getChatByJid("repair@g.us");
    assert.equal(after!.participant_count, 2, "count filled in");
    assert.equal(after!.name, "Repaired Group");
    assert.equal(after!.description, "now described");
    assert.equal(after!.is_community, 1);
    assert.equal(after!.is_community_announce, 0);
    assert.equal(after!.linked_parent, "parent@g.us");
    assert.equal(after!.last_message_at, 1700000000, "existing activity preserved");
    assert.equal(store.getGroupParticipants("repair@g.us").length, 2);
  });

  it("does not overwrite a good count or roster when a fetch returns no participants", async () => {
    const config = schema.WuConfigSchema.parse({ constraints: { default: "read" } });
    const full = {
      "keep@g.us": {
        id: "keep@g.us",
        subject: "Keep",
        participants: [
          { id: "1@s.whatsapp.net", admin: null },
          { id: "2@s.whatsapp.net", admin: null },
        ],
      },
    };
    await groups.refreshGroupMetadata(socketWithGroups(full), config);
    assert.equal(store.getChatByJid("keep@g.us")!.participant_count, 2);

    const result = await groups.refreshGroupMetadata(
      socketWithGroups({
        "keep@g.us": { id: "keep@g.us", subject: "Keep", participants: [] },
      }),
      config
    );

    assert.equal(result.rosters, 0, "an empty roster is not counted as written");
    assert.equal(store.getChatByJid("keep@g.us")!.participant_count, 2, "count preserved");
    assert.equal(store.getGroupParticipants("keep@g.us").length, 2, "roster preserved");
  });

  it("withholds description and roster for a group the constraints block", async () => {
    const config = schema.WuConfigSchema.parse({
      constraints: { default: "none", chats: {} },
      whatsapp: { group_discovery: true },
    });
    const result = await groups.refreshGroupMetadata(
      socketWithGroups({
        "blocked@g.us": {
          id: "blocked@g.us",
          subject: "Blocked Group",
          desc: "secret",
          participants: [{ id: "111@s.whatsapp.net", admin: null }],
        },
      }),
      config
    );

    assert.equal(result.groups, 1, "public header still recorded for discovery");
    assert.equal(result.rosters, 0, "no roster stored for a blocked group");

    const row = store.getChatByJid("blocked@g.us");
    assert.equal(row!.name, "Blocked Group", "name is public");
    assert.equal(row!.participant_count, 1, "count is public");
    assert.equal(row!.description, null, "description stays gated");
    assert.equal(store.getGroupParticipants("blocked@g.us").length, 0);
  });
});
