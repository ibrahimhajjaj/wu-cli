import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Redirect WU_HOME before importing anything that freezes paths from it.
const home = mkdtempSync(join(tmpdir(), "wu-cfgwatch-"));
process.env.WU_HOME = home;
mkdirSync(join(home, "auth"), { recursive: true });

let schema: typeof import("../src/config/schema.js");
let configWatch: typeof import("../src/core/config-watch.js");

before(async () => {
  schema = await import("../src/config/schema.js");
  configWatch = await import("../src/core/config-watch.js");
});

after(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("watchConfig", () => {
  it("reloads and reports the new config when the file changes", async () => {
    // Seed a starting config on disk.
    schema.saveConfig(
      schema.WuConfigSchema.parse({ constraints: { default: "none", chats: {} } })
    );

    const changes: string[] = [];
    const stop = configWatch.watchConfig(
      (cfg) => {
        const mode = cfg.constraints?.chats["late@g.us"]?.mode;
        if (mode) changes.push(mode);
      },
      { debounceMs: 50 }
    );

    try {
      // The config that newly allows a group - the daemon-side trigger.
      const allowed = schema.WuConfigSchema.parse({
        constraints: { default: "none", chats: { "late@g.us": { mode: "read" } } },
      });

      // fs.watch arms asynchronously (on macOS the FSEvents stream can miss
      // writes issued right after watch() returns), so keep re-writing the same
      // config until the watcher reports it. Rewriting is idempotent - the
      // assertion is that the change is observed, not how many events fired.
      const deadline = Date.now() + 15000;
      while (changes.length === 0 && Date.now() < deadline) {
        schema.saveConfig(allowed);
        await new Promise((r) => setTimeout(r, 100));
      }

      assert.ok(changes.length > 0, "watcher should have fired on the config write");
      assert.equal(changes[changes.length - 1], "read");
    } finally {
      stop();
    }
  });
});
