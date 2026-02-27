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
});

const DbConfig = z.object({
  path: z.string().optional(),
});

const LogConfig = z.object({
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export const WuConfigSchema = z.object({
  whatsapp: WhatsAppConfig.default({}),
  constraints: ConstraintsConfig.optional(),
  db: DbConfig.default({}),
  log: LogConfig.default({}),
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
