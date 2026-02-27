import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { WuConfigSchema, loadConfig, setConfigValue, saveConfig } from "../src/config/schema.js";

const TEST_DIR = join(tmpdir(), `wu-test-config-${process.pid}`);
const TEST_CONFIG = join(TEST_DIR, "config.yaml");

describe("WuConfigSchema", () => {
  it("should return defaults for empty object", () => {
    const config = WuConfigSchema.parse({});
    assert.equal(config.whatsapp.read_receipts, false);
    assert.equal(config.whatsapp.media_max_mb, 50);
    assert.equal(config.whatsapp.send_delay_ms, 1000);
    assert.equal(config.log.level, "info");
    assert.equal(config.constraints, undefined);
  });

  it("should parse full config", () => {
    const config = WuConfigSchema.parse({
      whatsapp: {
        read_receipts: true,
        media_max_mb: 25,
        send_delay_ms: 2000,
      },
      constraints: {
        default: "read",
        chats: {
          "120363XXX@g.us": { mode: "full" },
          "*@s.whatsapp.net": { mode: "none" },
        },
      },
      log: { level: "debug" },
    });
    assert.equal(config.whatsapp.read_receipts, true);
    assert.equal(config.whatsapp.media_max_mb, 25);
    assert.equal(config.constraints?.default, "read");
    assert.equal(config.constraints?.chats["120363XXX@g.us"].mode, "full");
    assert.equal(config.constraints?.chats["*@s.whatsapp.net"].mode, "none");
    assert.equal(config.log.level, "debug");
  });

  it("should reject invalid constraint mode", () => {
    assert.throws(() => {
      WuConfigSchema.parse({
        constraints: { default: "invalid" },
      });
    });
  });

  it("should reject invalid log level", () => {
    assert.throws(() => {
      WuConfigSchema.parse({
        log: { level: "verbose" },
      });
    });
  });
});

describe("loadConfig", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("should return defaults when file does not exist", () => {
    const config = loadConfig(join(TEST_DIR, "nonexistent.yaml"));
    assert.equal(config.whatsapp.read_receipts, false);
    assert.equal(config.log.level, "info");
  });

  it("should parse YAML config file", () => {
    writeFileSync(
      TEST_CONFIG,
      `
whatsapp:
  read_receipts: true
  media_max_mb: 10
log:
  level: debug
`
    );
    const config = loadConfig(TEST_CONFIG);
    assert.equal(config.whatsapp.read_receipts, true);
    assert.equal(config.whatsapp.media_max_mb, 10);
    assert.equal(config.log.level, "debug");
  });

  it("should handle empty YAML file", () => {
    writeFileSync(TEST_CONFIG, "");
    const config = loadConfig(TEST_CONFIG);
    assert.equal(config.whatsapp.read_receipts, false);
  });
});

describe("saveConfig + setConfigValue", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("should save and reload config", () => {
    const config = WuConfigSchema.parse({
      whatsapp: { send_delay_ms: 2000 },
    });
    saveConfig(config, TEST_CONFIG);
    const loaded = loadConfig(TEST_CONFIG);
    assert.equal(loaded.whatsapp.send_delay_ms, 2000);
  });
});
