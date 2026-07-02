import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarize, type DoctorCheck } from "../src/cli/doctor.js";
import { EXIT_SUCCESS, EXIT_GENERAL_ERROR } from "../src/cli/exit-codes.js";

// Only the pure aggregation logic is tested here - the live probes (auth,
// daemon lock, socket heartbeat, DB, remote SSH) need a running daemon/DB and
// are exercised manually via `wu doctor`.

function check(status: DoctorCheck["status"], name = "x"): DoctorCheck {
  return { name, status, detail: "detail" };
}

describe("summarize", () => {
  it("is ok when every check is ok", () => {
    const result = summarize([check("ok", "auth"), check("ok", "daemon")]);
    assert.equal(result.overall, "ok");
    assert.equal(result.exitCode, EXIT_SUCCESS);
  });

  it("stays ok when checks are skipped", () => {
    const result = summarize([check("ok", "auth"), check("skip", "remote")]);
    assert.equal(result.overall, "ok");
    assert.equal(result.exitCode, EXIT_SUCCESS);
  });

  it("is warn (but exit 0) when only advisory checks fail", () => {
    const result = summarize([check("ok", "auth"), check("warn", "enrich_ocr")]);
    assert.equal(result.overall, "warn");
    assert.equal(result.exitCode, EXIT_SUCCESS);
  });

  it("is fail with a non-zero exit code when any check is fatal", () => {
    const result = summarize([check("ok", "auth"), check("fail", "store_write")]);
    assert.equal(result.overall, "fail");
    assert.equal(result.exitCode, EXIT_GENERAL_ERROR);
  });

  it("fail takes priority over warn", () => {
    const result = summarize([check("warn", "enrich_ocr"), check("fail", "stream")]);
    assert.equal(result.overall, "fail");
    assert.equal(result.exitCode, EXIT_GENERAL_ERROR);
  });

  it("an empty check list is ok", () => {
    const result = summarize([]);
    assert.equal(result.overall, "ok");
    assert.equal(result.exitCode, EXIT_SUCCESS);
  });
});
