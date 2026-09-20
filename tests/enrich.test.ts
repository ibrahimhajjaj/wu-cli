import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveBackend, enrichStatus, enrichFile, resolveLanguage } from "../src/core/enrich.js";
import { WuConfigSchema, type EnrichConfig } from "../src/config/schema.js";

function cfg(over: Partial<EnrichConfig> = {}): EnrichConfig {
  const merged = {
    transcribe: { backend: "local", local: { cmd: "whisper {input}" }, api: { base_url: "https://x/v1", key_env: "NOPE_KEY", model: "m" } },
    ocr: { backend: "local", local: { cmd: "tesseract {input} stdout" }, api: { base_url: "https://x/v1", key_env: "NOPE_KEY", model: "m" } },
    ...over,
  } as Record<string, any>;
  // `languages` is a zod default, so a real config always has it; these
  // hand-built capabilities have to carry it too.
  for (const cap of ["transcribe", "ocr"]) merged[cap] = { languages: {}, ...merged[cap] };
  return merged as EnrichConfig;
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

describe("language pinning", () => {
  it("substitutes the pinned language into the local command", async () => {
    const text = await enrichFile(
      "ocr",
      "/tmp/x.png",
      cfg({ ocr: { backend: "local", language: "ara+eng", local: { cmd: "echo lang={lang}" } } } as any)
    );
    assert.equal(text, "lang=ara+eng");
  });

  it("drops the placeholder and its flag when no language is pinned", async () => {
    // A bare --language with nothing after it is an error in whisper, so an
    // unpinned language has to remove the whole flag, not leave it empty.
    const text = await enrichFile(
      "ocr",
      "/tmp/x.png",
      cfg({ ocr: { backend: "local", local: { cmd: "echo before --language {lang} after" } } } as any)
    );
    assert.equal(text, "before after");
  });

  it("names the pinned language in status, and nags only when transcribe has none", () => {
    const pinned = resolveBackend(
      "transcribe",
      cfg({ transcribe: { backend: "local", language: "ar", local: { cmd: "sh -c {input}" } } } as any)
    );
    assert.match(pinned.detail, /language ar/);
    assert.equal(pinned.note, undefined);

    const guessing = resolveBackend(
      "transcribe",
      cfg({ transcribe: { backend: "local", local: { cmd: "sh -c {input}" } } } as any)
    );
    assert.match(guessing.detail, /language auto-detected/);
    assert.match(guessing.note!, /enrich\.transcribe\.language/);

    // OCR reads what is on the page; there is nothing to nag about.
    const ocr = resolveBackend("ocr", cfg({ ocr: { backend: "local", local: { cmd: "sh -c {input}" } } } as any));
    assert.equal(ocr.note, undefined);
  });

  it("picks a chat's language over the global default, exact jid before wildcard", () => {
    const c = {
      backend: "local",
      language: "en",
      languages: { "friend@s.whatsapp.net": "ar", "*@g.us": "ar", "work@g.us": "de" },
      local: { cmd: "sh -c {input}" },
    } as any;
    assert.equal(resolveLanguage(c, "friend@s.whatsapp.net"), "ar");
    assert.equal(resolveLanguage(c, "work@g.us"), "de");
    assert.equal(resolveLanguage(c, "anything@g.us"), "ar");
    assert.equal(resolveLanguage(c, "stranger@s.whatsapp.net"), "en");
    assert.equal(resolveLanguage(c, undefined), "en");

    // No default at all means the uncovered chats keep auto-detecting.
    const noDefault = { ...c, language: undefined } as any;
    assert.equal(resolveLanguage(noDefault, "stranger@s.whatsapp.net"), undefined);
  });

  it("renders the chat's language into the command that runs for it", async () => {
    const c = cfg({
      ocr: { backend: "local", language: "en", languages: { "g@g.us": "ar" }, local: { cmd: "echo lang={lang}" } },
    } as any);
    assert.equal(await enrichFile("ocr", "/tmp/x.png", c, "g@g.us"), "lang=ar");
    assert.equal(await enrichFile("ocr", "/tmp/x.png", c, "other@s.whatsapp.net"), "lang=en");
  });

  it("leaves alone a command that names the language itself", () => {
    const own = resolveBackend(
      "transcribe",
      cfg({ transcribe: { backend: "local", local: { cmd: "sh -c {input} --language ar" } } } as any)
    );
    assert.equal(own.note, undefined);
    assert.match(own.detail, /language set in cmd/);

    // The shipped template carries the flag too, but it drops out unrendered,
    // so it must not read as pinned. Asserted on the note rather than the
    // detail, which depends on whisper being installed on the machine running
    // the tests.
    const shipped = resolveBackend("transcribe", WuConfigSchema.parse({}).enrich);
    assert.match(shipped.note!, /pin it/);
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
