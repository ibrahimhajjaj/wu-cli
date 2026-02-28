import { execFileSync, execSync } from "child_process";
import { mkdirSync, writeFileSync, realpathSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { WU_HOME } from "../config/paths.js";

// --- Resolve wu binary path ---

export function resolveWuBin(): string {
  const candidates: (string | false | null | undefined)[] = [
    // Bun-compiled binary
    typeof globalThis !== "undefined" && (globalThis as any).Bun && (globalThis as any).Bun.execPath,
    // Node: process.argv[1] is the script
    process.argv[1],
    // Last resort: which wu
    (() => {
      try { return execSync("which wu", { stdio: "pipe" }).toString().trim(); } catch { return null; }
    })(),
  ];

  const filtered = candidates.filter(Boolean) as string[];
  for (const c of filtered) {
    try { return realpathSync(c); } catch {}
  }

  throw new Error("Cannot resolve wu binary path. Is wu installed?");
}

// --- Resolve WU_HOME to absolute ---

function resolveHome(): string {
  if (WU_HOME.startsWith("~")) {
    return WU_HOME.replace("~", homedir());
  }
  return resolve(WU_HOME);
}

// --- Systemd directory ---

function systemdUserDir(): string {
  const dir = join(homedir(), ".config", "systemd", "user");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// --- Daemon service ---

export async function generateDaemonService(): Promise<void> {
  const wuBin = resolveWuBin();
  const wuHome = resolveHome();
  const dir = systemdUserDir();

  const service = `[Unit]
Description=wu WhatsApp daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${wuBin} daemon
Restart=on-failure
RestartSec=10
Environment=WU_HOME=${wuHome}

[Install]
WantedBy=default.target
`;

  writeFileSync(join(dir, "wu.service"), service, "utf-8");

  execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe" });
  execFileSync("systemctl", ["--user", "enable", "--now", "wu"], { stdio: "pipe" });
}

// --- Sync service + timer ---

export async function generateSyncService(): Promise<void> {
  const wuBin = resolveWuBin();
  const wuHome = resolveHome();
  const dir = systemdUserDir();

  const service = `[Unit]
Description=wu database sync

[Service]
Type=oneshot
ExecStart=${wuBin} sync pull
Environment=WU_HOME=${wuHome}
`;

  writeFileSync(join(dir, "wu-sync.service"), service, "utf-8");
}

export async function generateSyncTimer(intervalSec: number): Promise<void> {
  const dir = systemdUserDir();

  const timer = `[Unit]
Description=wu database sync timer

[Timer]
OnUnitActiveSec=${intervalSec}s
AccuracySec=5s

[Install]
WantedBy=timers.target
`;

  writeFileSync(join(dir, "wu-sync.timer"), timer, "utf-8");

  execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe" });
  execFileSync("systemctl", ["--user", "enable", "--now", "wu-sync.timer"], { stdio: "pipe" });
}

// --- Linger check ---

export function checkLinger(): boolean {
  try {
    const whoami = execSync("whoami", { stdio: "pipe" }).toString().trim();
    const output = execFileSync(
      "loginctl",
      ["show-user", whoami, "-p", "Linger"],
      { stdio: "pipe" },
    ).toString().trim();
    return output === "Linger=yes";
  } catch {
    return false;
  }
}
