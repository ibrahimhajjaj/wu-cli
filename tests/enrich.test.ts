import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveBackend, enrichStatus, enrichFile } from "../src/core/enrich.js";
import type { EnrichConfig } from "../src/config/schema.js";

function cfg(over: Partial<EnrichConfig> = {}): EnrichConfig {
  return {
    transcribe: { backend: "local", local: { cmd: "whisper {input}" }, api: { base_url: "https://x/v1", key_env: "NOPE_KEY", model: "m" } },
    ocr: { backend: "local", local: { cmd: "tesseract {input} stdout" }, api: { base_url: "https://x/v1", key_env: "NOPE_KEY", model: "m" } },
    ...over,
  } as EnrichConfig;
}

describe("resolveBackend", () => {
  it("reports off with an enable hint", () => {
    const s = resolveBackend("transcribe", cfg({ transcribe: { backend: "off", local: { cmd: "whisper {input}" } } as any }));
    assert.equal(s.available, false);
    assert.match(s.enable_hint, /backend/);
  });

  it("local backend unavailable when binary is missing", () => {
    const s = resolveBackend("transcribe", cfg({ transcribe: { backend: "local", local: { cmd: "definitely-not-a-real-bin-xyz {input}" } } as any }));
    assert.equal(s.available, false);
    assert.match(s.detail, /not found on PATH/);
  });

  it("local backend available when binary exists", () => {
    const s = resolveBackend("ocr", cfg({ ocr: { backend: "local", local: { cmd: "sh -c {input}" } } as any }));
    assert.equal(s.available, true);
    assert.match(s.detail, /local: sh/);
  });

  it("api backend needs its key env set", () => {
    const off = resolveBackend("transcribe", cfg({ transcribe: { backend: "api", local: { cmd: "whisper {input}" }, api: { base_url: "https://x/v1", key_env: "WU_TEST_KEY_UNSET", model: "m" } } as any }));
    assert.equal(off.available, false);
    process.env.WU_TEST_KEY_SET = "secret";
    const on = resolveBackend("transcribe", cfg({ transcribe: { backend: "api", local: { cmd: "whisper {input}" }, api: { base_url: "https://x/v1", key_env: "WU_TEST_KEY_SET", model: "whisper-large" } } as any }));
    assert.equal(on.available, true);
    assert.match(on.detail, /whisper-large/);
    delete process.env.WU_TEST_KEY_SET;
  });
});

describe("enrichStatus", () => {
  it("covers both capabilities", () => {
    const rows = enrichStatus(cfg());
    assert.deepEqual(rows.map((r) => r.capability).sort(), ["ocr", "transcribe"]);
  });
});

describe("enrichFile local backend", () => {
  it("runs the local command and returns stdout", async () => {
    // 'cat {input}' echoes the file back as the extracted text.
    const text = await enrichFile("ocr", "/dev/stdin", cfg({ ocr: { backend: "local", local: { cmd: "echo hello-ocr" } } as any }));
    assert.equal(text, "hello-ocr");
  });

  it("throws an actionable error when the backend is unavailable", async () => {
    await assert.rejects(
      () => enrichFile("transcribe", "/tmp/x.ogg", cfg({ transcribe: { backend: "local", local: { cmd: "nope-bin-xyz {input}" } } as any })),
      /not available/
    );
  });
});
