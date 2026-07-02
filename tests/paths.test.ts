import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { statSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const HOME = join(tmpdir(), `wu-paths-${process.pid}`);

describe("ensureWuHome permissions", () => {
  after(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch {} });

  it("creates WU_HOME and auth dir as 0700", async () => {
    process.env.WU_HOME = HOME;
    const paths = await import("../src/config/paths.js");
    paths.ensureWuHome();
    assert.equal(statSync(paths.WU_HOME).mode & 0o777, 0o700);
    assert.equal(statSync(paths.AUTH_DIR).mode & 0o777, 0o700);
  });
});
