import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { z } from "zod";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { CONFIG_PATH } from "./paths.js";

const ConstraintMode = z.enum(["full", "read", "none"]);
export type ConstraintMode = z.infer<typeof ConstraintMode>;

const ChatConstraint = z.object({
  mode: ConstraintMode,
});

const ConstraintsConfig = z.object({
  default: ConstraintMode.default("none"),
  chats: z.record(z.string(), ChatConstraint).default({}),
});

const WhatsAppConfig = z.object({
  read_receipts: z.boolean().default(false),
  media_max_mb: z.number().default(50),
  media_dir: z.string().optional(),
  send_delay_ms: z.number().default(1000),
  // When true (default), group metadata (jid + name + community shape) is cached
  // unconditionally so users can discover groups to opt into. Set to false for
  // strict mode: group metadata only stored when the constraint allows.
  // DMs are always constraint-gated regardless of this flag because DM JIDs
  // contain the contact's phone number.
  group_discovery: z.boolean().default(true),
});

const DbConfig = z.object({
  path: z.string().optional(),
});

const LogConfig = z.object({
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

const RemoteConfig = z.object({
  host: z.string(),
  wu_home: z.string().default("~/.wu"),
});
export type RemoteConfig = z.infer<typeof RemoteConfig>;

// Enrichment backends. Each capability picks one: a local binary that emits the
// extracted text on stdout, or a hosted API. Ships defaulting to local so it is
// free and offline once the binary is installed; the API path is opt-in.
const EnrichLocal = z.object({
  // {input} is replaced with the media file path; the command must print the
  // extracted text to stdout.
  cmd: z.string(),
});
const EnrichApi = z.object({
  base_url: z.string(),
  key_env: z.string(),
  model: z.string(),
});
const EnrichCapability = z.object({
  backend: z.enum(["off", "local", "api"]).default("local"),
  local: EnrichLocal,
  api: EnrichApi.optional(),
});
const EnrichConfig = z.object({
  transcribe: EnrichCapability.default({
    backend: "local",
    local: { cmd: "whisper {input} --model base --output_format txt --output_dir {outdir}" },
    api: { base_url: "https://api.groq.com/openai/v1", key_env: "GROQ_API_KEY", model: "whisper-large-v3" },
  }),
  ocr: EnrichCapability.default({
    backend: "local",
    local: { cmd: "tesseract {input} stdout -l ara+eng" },
    api: { base_url: "https://api.anthropic.com/v1", key_env: "ANTHROPIC_API_KEY", model: "claude-haiku-4-5-20251001" },
  }),
});
export type EnrichConfig = z.infer<typeof EnrichConfig>;
export type EnrichCapabilityConfig = z.infer<typeof EnrichCapability>;

export const WuConfigSchema = z.object({
  whatsapp: WhatsAppConfig.default({}),
  constraints: ConstraintsConfig.optional(),
  db: DbConfig.default({}),
  log: LogConfig.default({}),
  remotes: z.record(z.string(), RemoteConfig).optional(),
  default_remote: z.string().optional(),
  enrich: EnrichConfig.default({}),
});

export type WuConfig = z.infer<typeof WuConfigSchema>;

export function loadConfig(path?: string): WuConfig {
  const configPath = path || CONFIG_PATH;
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(raw);
    return WuConfigSchema.parse(parsed || {});
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "ENOENT"
    ) {
      return WuConfigSchema.parse({});
    }
    throw err;
  }
}

export function saveConfig(config: WuConfig, path?: string): void {
  const configPath = path || CONFIG_PATH;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, stringifyYaml(config), "utf-8");
}

export function setConfigValue(
  dotPath: string,
  value: string
): WuConfig {
  const config = loadConfig();
  const parts = dotPath.split(".");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let obj: any = config;
  for (let i = 0; i < parts.length - 1; i++) {
    if (obj[parts[i]] === undefined) {
      obj[parts[i]] = {};
    }
    obj = obj[parts[i]];
  }
  const lastKey = parts[parts.length - 1];

  // Try to parse as number/boolean
  let parsed: unknown = value;
  if (value === "true") parsed = true;
  else if (value === "false") parsed = false;
  else if (!isNaN(Number(value)) && value !== "") parsed = Number(value);

  obj[lastKey] = parsed;

  // Re-validate
  const validated = WuConfigSchema.parse(config);
  saveConfig(validated);
  return validated;
}
