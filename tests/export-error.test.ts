import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// exportMessages streams rows through an open fd across a batch loop.
// mediaLabel/quotedSnippet deserialize `raw` for some types, which throws on
// a corrupt blob mid-loop. Before the fix that leaked the fd and left a
// truncated file behind. We insert a row whose `raw` fails JSON.parse, assert
// the export throws, then export a clean chat to the same path and assert
// it succeeds - the second open would still succeed on a leaked fd (Unix
// doesn't lock plain writes), but a stuck fd would still leave the process
// holding a dangling handle, so we also check the second export's output is
// exactly the clean chat's content, not a mix of the two attempts.

const home = mkdtempSync(join(tmpdir(), "wu-export-error-"));
process.env.WU_HOME = home;
mkdirSync(join(home, "auth"), { recursive: true });

let store: typeof import("../src/core/store.js");
let database: typeof import("../src/db/database.js");
let exportMod: typeof import("../src/core/export.js");

before(async () => {
  database = await import("../src/db/database.js");
  store = await import("../src/core/store.js");
  exportMod = await import("../src/core/export.js");
  database.getDb();
});

after(() => {
  database.closeDb();
  rmSync(home, { recursive: true, force: true });
});

function insertMessage(overrides: {
  id: string;
  chat_jid: string;
  body: string | null;
  type: string;
  raw: string | null;
  timestamp: number;
}): void {
  store.upsertMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender_jid: "9@s.whatsapp.net",
    sender_name: "Tester",
    body: overrides.body,
    type: overrides.type,
    media_mime: overrides.type === "document" ? "application/pdf" : null,
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
    timestamp: overrides.timestamp,
    raw: overrides.raw,
  });
}

describe("exportMessages fd lifecycle", () => {
  it("releases the fd on a mid-batch throw so a later export to the same path still works", () => {
    const corruptChat = "corrupt-chat@g.us";
    const cleanChat = "clean-chat@g.us";
    insertMessage({
      id: "doc-1",
      chat_jid: corruptChat,
      body: null,
      type: "document",
      raw: "{not json",
      timestamp: 1782292000,
    });
    insertMessage({
      id: "text-1",
      chat_jid: cleanChat,
      body: "hello from the clean chat",
      type: "text",
      raw: "{}",
      timestamp: 1782292100,
    });

    const outPath = join(home, "export-out.md");

    assert.throws(() =>
      exportMod.exportMessages({ chatJid: corruptChat, format: "markdown", output: outPath })
    );

    const result = exportMod.exportMessages({ chatJid: cleanChat, format: "markdown", output: outPath });
    assert.equal(result.messages_exported, 1);

    const content = readFileSync(outPath, "utf-8");
    assert.match(content, /hello from the clean chat/);
    assert.doesNotMatch(content, /document/);
  });
});
