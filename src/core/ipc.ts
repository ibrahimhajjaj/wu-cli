import { createServer, connect, type Socket } from "net";
import { existsSync, unlinkSync, chmodSync } from "fs";
import type { WASocket } from "@whiskeysockets/baileys";
import type { WuConfig } from "../config/schema.js";
import { DAEMON_SOCK_PATH } from "../config/paths.js";
import { downloadMedia, downloadMediaBatch } from "./media.js";
import { collectUndownloadedMedia } from "./export.js";
import { createChildLogger } from "../config/logger.js";

const logger = createChildLogger("ipc");

// Newline-delimited JSON request/response over a unix domain socket. The
// daemon owns the only live WhatsApp socket, so anything that needs the socket
// (media download) routes here instead of opening a competing login.

interface IpcRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface IpcResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

// --- Server (runs inside the daemon) ---

export function startDaemonIpc(
  getSock: () => WASocket | undefined,
  config: WuConfig,
  sockPath: string = DAEMON_SOCK_PATH
): () => void {
  // Clear a stale socket left by a crash so bind() succeeds.
  if (existsSync(sockPath)) {
    try { unlinkSync(sockPath); } catch { /* best effort */ }
  }

  const server = createServer((conn) => {
    let buffer = "";
    conn.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) void handleLine(conn, line, getSock, config);
      }
    });
    conn.on("error", () => { /* client went away mid-request */ });
  });

  server.on("error", (err) => {
    logger.error({ err }, "IPC server error");
  });

  server.listen(sockPath, () => {
    try { chmodSync(sockPath, 0o600); } catch { /* best effort */ }
    logger.debug({ path: sockPath }, "IPC server listening");
  });

  return () => {
    server.close();
    try { if (existsSync(sockPath)) unlinkSync(sockPath); } catch { /* best effort */ }
  };
}

async function handleLine(
  conn: Socket,
  line: string,
  getSock: () => WASocket | undefined,
  config: WuConfig
): Promise<void> {
  let req: IpcRequest;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }

  const respond = (res: Omit<IpcResponse, "id">) => {
    const payload: IpcResponse = { id: req.id, ...res };
    try { conn.write(JSON.stringify(payload) + "\n"); } catch { /* ignore */ }
  };

  try {
    const result = await dispatch(req, getSock, config);
    respond({ ok: true, result });
  } catch (err) {
    respond({ ok: false, error: (err as Error).message });
  }
}

async function dispatch(
  req: IpcRequest,
  getSock: () => WASocket | undefined,
  config: WuConfig
): Promise<unknown> {
  const params = req.params || {};

  if (req.method === "ping") return { pong: true };

  const requireSock = (): WASocket => {
    const sock = getSock();
    if (!sock) throw new Error("Daemon is not connected to WhatsApp");
    return sock;
  };

  switch (req.method) {
    case "media.download": {
      const sock = requireSock();
      const msgId = String(params.msgId);
      const outDir = params.outDir ? String(params.outDir) : undefined;
      return downloadMedia(msgId, sock, config, outDir);
    }
    case "media.downloadBatch": {
      const sock = requireSock();
      let ids = (params.msgIds as string[] | undefined) ?? undefined;
      if (!ids || ids.length === 0) {
        const chat = params.chat ? String(params.chat) : undefined;
        if (!chat) throw new Error("Provide msgIds or chat");
        const limitRaw = Number(params.limit ?? 50);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 50;
        ids = collectUndownloadedMedia(chat, undefined, undefined, [], { limit, order: "desc" });
      }
      if (ids.length === 0) return { results: [], errors: [] };
      const outDir = params.outDir ? String(params.outDir) : undefined;
      const concurrencyRaw = Number(params.concurrency ?? 4);
      const concurrency = Number.isFinite(concurrencyRaw) && concurrencyRaw > 0 ? Math.floor(concurrencyRaw) : 4;
      return downloadMediaBatch(ids, sock, config, outDir, { concurrency });
    }
    default:
      throw new Error(`Unknown IPC method: ${req.method}`);
  }
}

// --- Client (CLI / MCP side) ---

// True when a daemon IPC socket is present and accepting connections.
export function daemonIpcAvailable(
  timeoutMs = 1000,
  sockPath: string = DAEMON_SOCK_PATH
): Promise<boolean> {
  return new Promise((resolve) => {
    if (!existsSync(sockPath)) {
      resolve(false);
      return;
    }
    const conn = connect(sockPath);
    const done = (ok: boolean) => {
      conn.destroy();
      resolve(ok);
    };
    conn.setTimeout(timeoutMs);
    conn.once("connect", () => done(true));
    conn.once("error", () => done(false));
    conn.once("timeout", () => done(false));
  });
}

export function daemonRequest<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 300_000,
  sockPath: string = DAEMON_SOCK_PATH
): Promise<T> {
  return new Promise((resolve, reject) => {
    const conn = connect(sockPath);
    let buffer = "";
    let settled = false;

    const finish = (err: Error | null, value?: T) => {
      if (settled) return;
      settled = true;
      conn.destroy();
      if (err) reject(err);
      else resolve(value as T);
    };

    const timer = setTimeout(() => finish(new Error("Daemon request timed out")), timeoutMs);
    timer.unref?.();

    conn.once("connect", () => {
      conn.write(JSON.stringify({ id: 1, method, params }) + "\n");
    });
    conn.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      clearTimeout(timer);
      try {
        const res = JSON.parse(buffer.slice(0, nl)) as IpcResponse;
        if (res.ok) finish(null, res.result as T);
        else finish(new Error(res.error || "Daemon request failed"));
      } catch (err) {
        finish(err as Error);
      }
    });
    conn.once("error", (err) => { clearTimeout(timer); finish(err); });
    conn.once("close", () => {
      clearTimeout(timer);
      finish(new Error("Daemon closed the connection before responding"));
    });
  });
}
