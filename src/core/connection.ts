import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  type WASocket,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { Boom } from "@hapi/boom";
import { AUTH_DIR } from "../config/paths.js";
import { createChildLogger } from "../config/logger.js";

const logger = createChildLogger("connection");
const silentLogger = pino({ level: "silent" });

import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const VERSION = _require("../../package.json").version;

export interface ConnectionOptions {
  /** Called when QR code is available for scanning */
  onQr?: (qr: string) => void;
  /** Called when pairing code is generated */
  onPairingCode?: (code: string) => void;
  /** Called when connection is established */
  onOpen?: () => void;
  /** Called on connection close */
  onClose?: (reason: number, willReconnect: boolean) => void;
  /** Whether this is a daemon-mode connection (affects 440 handling) */
  isDaemon?: boolean;
  /** Phone number for pairing code auth */
  pairingPhone?: string;
  /** Suppress Baileys protocol logs (for interactive CLI commands) */
  quiet?: boolean;
}

export interface ConnectionState {
  sock: WASocket;
  saveCreds: () => Promise<void>;
  flushCreds: () => Promise<void>;
}

let credsTimer: ReturnType<typeof setTimeout> | undefined;

export async function createConnection(
  opts: ConnectionOptions = {}
): Promise<ConnectionState> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const log = opts.quiet ? silentLogger : logger;

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, log as any),
    },
    version,
    browser: ["wu-cli", "cli", VERSION],
    syncFullHistory: true,
    markOnlineOnConnect: false,
    logger: log as any,
    generateHighQualityLinkPreview: false,
  });

  // Debounced credential saving (500ms)
  let credsDirty = false;
  const debouncedSaveCreds = async () => {
    credsDirty = true;
    if (credsTimer) clearTimeout(credsTimer);
    credsTimer = setTimeout(async () => {
      if (credsDirty) {
        await saveCreds();
        credsDirty = false;
      }
    }, 500);
  };

  const flushCreds = async () => {
    if (credsTimer) clearTimeout(credsTimer);
    if (credsDirty) {
      await saveCreds();
      credsDirty = false;
    }
  };

  sock.ev.on("creds.update", debouncedSaveCreds);

  // Handle connection updates (QR, open, close)
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      if (opts.pairingPhone) {
        const code = await sock.requestPairingCode(opts.pairingPhone);
        opts.onPairingCode?.(code);
      } else {
        opts.onQr?.(qr);
      }
    }

    if (connection === "open") {
      opts.onOpen?.();
    }

    if (connection === "close") {
      const statusCode =
        (lastDisconnect?.error as Boom)?.output?.statusCode ??
        DisconnectReason.connectionClosed;

      const shouldReconnect = handleDisconnect(log, statusCode, opts.isDaemon);
      opts.onClose?.(statusCode, shouldReconnect);
    }
  });

  return { sock, saveCreds: debouncedSaveCreds, flushCreds };
}

function handleDisconnect(log: pino.Logger, statusCode: number, isDaemon?: boolean): boolean {
  switch (statusCode) {
    case DisconnectReason.loggedOut:
      log.error("Logged out — need to re-login with `wu login`");
      return false;

    case DisconnectReason.connectionLost:
    case DisconnectReason.timedOut:
      log.warn("Connection lost/timed out — will reconnect");
      return true;

    case DisconnectReason.multideviceMismatch:
      log.error("Multi-device version mismatch — fatal");
      return false;

    case DisconnectReason.connectionClosed:
      log.warn("Connection closed — will reconnect");
      return true;

    case DisconnectReason.connectionReplaced:
      if (isDaemon) {
        log.warn(
          "Connection replaced (likely a one-shot command) — reconnecting in 5s"
        );
        return true;
      }
      log.error("Connection replaced by another session");
      return false;

    case DisconnectReason.badSession:
      log.error("Bad session — need to re-login with `wu login`");
      return false;

    case DisconnectReason.unavailableService:
      log.warn("WhatsApp service unavailable — will retry");
      return true;

    case DisconnectReason.restartRequired:
      log.info("Restart required — reconnecting immediately");
      return true;

    default:
      log.warn({ statusCode }, "Unknown disconnect reason — will reconnect");
      return true;
  }
}

export class ConnectionError extends Error {
  constructor(public statusCode: number) {
    super(`Connection closed with status ${statusCode}`);
    this.name = "ConnectionError";
  }
}

export async function waitForConnection(
  sock: WASocket
): Promise<void> {
  return new Promise((resolve, reject) => {
    const handler = (update: { connection?: string; lastDisconnect?: { error?: Error } }) => {
      if (update.connection === "open") {
        sock.ev.off("connection.update", handler);
        resolve();
      }
      if (update.connection === "close") {
        sock.ev.off("connection.update", handler);
        const statusCode =
          (update.lastDisconnect?.error as Boom)?.output?.statusCode ?? 0;
        reject(new ConnectionError(statusCode));
      }
    };
    sock.ev.on("connection.update", handler);
  });
}

export async function withConnection<T>(
  fn: (sock: WASocket) => Promise<T>,
  opts?: { quiet?: boolean }
): Promise<T> {
  const { sock, flushCreds } = await createConnection({ quiet: opts?.quiet });

  try {
    await waitForConnection(sock);
    return await fn(sock);
  } finally {
    await flushCreds();
    sock.end(undefined);
  }
}

export class ReconnectingConnection {
  private sock: WASocket | undefined;
  private flushCreds: (() => Promise<void>) | undefined;
  private backoff = 2000;
  private maxBackoff = 60000;
  private consecutiveFailures = 0;
  private maxFailures = 10;
  private stopped = false;
  private onReady?: (sock: WASocket) => void;
  private onDisconnect?: () => void;
  private isDaemon: boolean;

  private quiet: boolean;
  private onReconnecting?: (delayMs: number) => void;
  private onFatal?: (reason: string) => void;

  constructor(opts: {
    isDaemon?: boolean;
    quiet?: boolean;
    onReady?: (sock: WASocket) => void;
    onDisconnect?: () => void;
    onReconnecting?: (delayMs: number) => void;
    onFatal?: (reason: string) => void;
  }) {
    this.isDaemon = opts.isDaemon ?? false;
    this.quiet = opts.quiet ?? false;
    this.onReady = opts.onReady;
    this.onDisconnect = opts.onDisconnect;
    this.onReconnecting = opts.onReconnecting;
    this.onFatal = opts.onFatal;
  }

  async start(): Promise<WASocket> {
    return this.connect();
  }

  private async connect(): Promise<WASocket> {
    const { sock, flushCreds } = await createConnection({
      isDaemon: this.isDaemon,
      quiet: this.quiet,
      onOpen: () => {
        this.consecutiveFailures = 0;
        this.backoff = 2000;
        this.onReady?.(sock);
      },
      onClose: async (_reason, willReconnect) => {
        this.onDisconnect?.();
        if (willReconnect && !this.stopped) {
          this.consecutiveFailures++;
          if (this.consecutiveFailures >= this.maxFailures) {
            this.onFatal?.("Too many consecutive failures — giving up");
            if (!this.quiet) logger.error("Too many consecutive failures — giving up");
            return;
          }
          const delay =
            _reason === DisconnectReason.connectionReplaced
              ? 5000
              : Math.min(this.backoff * Math.pow(2, this.consecutiveFailures - 1), this.maxBackoff);
          this.onReconnecting?.(delay);
          if (!this.quiet) logger.info({ delay }, "Reconnecting...");
          setTimeout(() => {
            if (!this.stopped) this.connect().catch(() => {});
          }, delay);
        }
      },
      onQr: () => {
        if (!this.quiet) logger.warn("QR code requested during reconnection — already authenticated?");
      },
    });

    this.sock = sock;
    this.flushCreds = flushCreds;
    await waitForConnection(sock);
    return sock;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.flushCreds) await this.flushCreds();
    if (this.sock) this.sock.end(undefined);
  }

  getSock(): WASocket | undefined {
    return this.sock;
  }
}
