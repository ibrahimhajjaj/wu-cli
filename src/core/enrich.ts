import { spawnSync } from "child_process";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "fs";
import { basename, join } from "path";
import { tmpdir } from "os";
import type { EnrichConfig, EnrichCapabilityConfig } from "../config/schema.js";
import { shellEscape } from "./remote.js";

export type Capability = "transcribe" | "ocr";

export interface BackendStatus {
  capability: Capability;
  backend: "off" | "local" | "api";
  available: boolean;
  detail: string;
  enable_hint: string;
}

function binOnPath(bin: string): boolean {
  if (!bin) return false;
  const res = spawnSync("/bin/sh", ["-c", `command -v ${shellEscape(bin)}`], { stdio: "ignore" });
  return res.status === 0;
}

// The binary a local command would invoke (first token of the template).
function localBin(cap: EnrichCapabilityConfig): string {
  return cap.local.cmd.trim().split(/\s+/)[0] || "";
}

function installHint(cap: Capability, bin: string): string {
  const common: Record<string, string> = {
    whisper: "pip install -U openai-whisper (or build whisper.cpp and point enrich.transcribe.local.cmd at it)",
    "whisper-cli": "build whisper.cpp; ensure whisper-cli is on PATH",
    tesseract: "install tesseract with the ara+eng language data (brew install tesseract tesseract-lang)",
  };
  return common[bin] || `install '${bin}' and put it on PATH, or set enrich.${cap}.backend to api`;
}

export function resolveBackend(cap: Capability, config: EnrichConfig): BackendStatus {
  const c = config[cap];
  if (c.backend === "off") {
    return {
      capability: cap,
      backend: "off",
      available: false,
      detail: "disabled",
      enable_hint: `set enrich.${cap}.backend to 'local' or 'api'`,
    };
  }
  if (c.backend === "local") {
    const bin = localBin(c);
    const ok = binOnPath(bin);
    return {
      capability: cap,
      backend: "local",
      available: ok,
      detail: ok ? `local: ${bin}` : `local backend '${bin}' not found on PATH`,
      enable_hint: ok ? "" : installHint(cap, bin),
    };
  }
  // api
  const api = c.api;
  const key = api ? process.env[api.key_env] : undefined;
  const ok = !!api && !!key;
  return {
    capability: cap,
    backend: "api",
    available: ok,
    detail: ok ? `api: ${api!.model}` : !api ? "no api config" : `${api.key_env} not set`,
    enable_hint: ok ? "" : api ? `export ${api.key_env}=...` : `configure enrich.${cap}.api`,
  };
}

export function enrichStatus(config: EnrichConfig): BackendStatus[] {
  return (["transcribe", "ocr"] as Capability[]).map((cap) => resolveBackend(cap, config));
}

export class EnrichUnavailableError extends Error {
  constructor(public status: BackendStatus) {
    super(
      `${status.capability} is not available (${status.detail}). ${status.enable_hint}`.trim()
    );
    this.name = "EnrichUnavailableError";
  }
}

// Run the configured local command, substituting {input}. Two output styles:
//   - stdout: the command prints the text (e.g. tesseract ... stdout)
//   - {outdir}: the command writes a .txt into a temp dir we provide (e.g.
//     whisper --output_dir {outdir}); we read it back
function runLocal(cmdTemplate: string, inputPath: string): string {
  const usesOutdir = cmdTemplate.includes("{outdir}");
  let outdir: string | undefined;
  let cmd = cmdTemplate.replace(/\{input\}/g, shellEscape(inputPath));
  if (usesOutdir) {
    outdir = mkdtempSync(join(tmpdir(), "wu-enrich-"));
    cmd = cmd.replace(/\{outdir\}/g, shellEscape(outdir));
  }

  try {
    const res = spawnSync("/bin/sh", ["-c", cmd], {
      encoding: "utf-8",
      maxBuffer: 32 * 1024 * 1024,
    });
    if (res.status !== 0) {
      throw new Error(`local command failed (${res.status}): ${(res.stderr || "").trim().slice(0, 500)}`);
    }

    let out: string;
    if (usesOutdir) {
      const txt = readdirSync(outdir!).find((f) => f.endsWith(".txt"));
      out = txt ? readFileSync(join(outdir!, txt), "utf-8").trim() : "";
      if (!out) throw new Error("local command wrote no .txt output");
    } else {
      out = (res.stdout || "").trim();
      if (!out) throw new Error("local command produced no text on stdout");
    }
    return out;
  } finally {
    if (outdir) {
      try { rmSync(outdir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

const AUDIO_MIME: Record<string, string> = {
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
};

// OpenAI-compatible audio transcription (Groq, OpenAI, ...).
async function transcribeViaApi(file: string, api: NonNullable<EnrichCapabilityConfig["api"]>): Promise<string> {
  const key = process.env[api.key_env]!;
  const ext = (basename(file).match(/\.[^.]+$/)?.[0] || "").toLowerCase();
  const blob = new Blob([readFileSync(file)], { type: AUDIO_MIME[ext] || "application/octet-stream" });
  const form = new FormData();
  form.append("file", blob, basename(file));
  form.append("model", api.model);
  const res = await fetch(`${api.base_url.replace(/\/$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) throw new Error(`transcription API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { text?: string };
  return (json.text || "").trim();
}

const IMAGE_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

// Anthropic vision: extract text from an image.
async function ocrViaApi(file: string, api: NonNullable<EnrichCapabilityConfig["api"]>): Promise<string> {
  const key = process.env[api.key_env]!;
  const ext = (basename(file).match(/\.[^.]+$/)?.[0] || "").toLowerCase();
  const media_type = IMAGE_MIME[ext] || "image/jpeg";
  const data = readFileSync(file).toString("base64");
  const res = await fetch(`${api.base_url.replace(/\/$/, "")}/messages`, {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: api.model,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type, data } },
            { type: "text", text: "Transcribe all text in this image verbatim, in its original language(s). Output only the text, no commentary." },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OCR API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { content?: Array<{ text?: string }> };
  return (json.content?.map((c) => c.text || "").join("") || "").trim();
}

// Extract text from a media file using the configured backend for `cap`.
export async function enrichFile(cap: Capability, file: string, config: EnrichConfig): Promise<string> {
  const status = resolveBackend(cap, config);
  if (!status.available) throw new EnrichUnavailableError(status);

  const c = config[cap];
  if (c.backend === "local") return runLocal(c.local.cmd, file);
  if (cap === "transcribe") return transcribeViaApi(file, c.api!);
  return ocrViaApi(file, c.api!);
}
