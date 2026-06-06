import { execFile, execFileSync } from "child_process";
import { existsSync, renameSync, unlinkSync, statSync } from "fs";
import type { WuConfig, RemoteConfig } from "../config/schema.js";

// --- Shell escaping (POSIX-safe) ---

export function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

// Expand ~ to $HOME for remote shell (single-quoted ~ won't expand)
export function remotePath(path: string): string {
  if (path.startsWith("~/")) {
    return `"$HOME/${path.slice(2)}"`;
  }
  if (path === "~") {
    return '"$HOME"';
  }
  return shellEscape(path);
}

// --- SSH connection multiplexing ---

const CONTROL_PATH = "/tmp/wu-ssh-%r@%h:%p";

function sshControlArgs(): string[] {
  return [
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${CONTROL_PATH}`,
    "-o", "ControlPersist=300",
    "-o", "ConnectTimeout=10",
  ];
}

// --- SSH execution ---

const DEFAULT_SSH_TIMEOUT = 30_000;

function spawnSsh(
  args: string[],
  retries = 1,
  timeoutMs = DEFAULT_SSH_TIMEOUT,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile("ssh", args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const exitCode = err ? (err as any).code ?? 1 : 0;

      // Retry on transient SSH errors
      if (
        retries > 0 &&
        exitCode !== 0 &&
        /connection reset|timed out|broken pipe/i.test(stderr)
      ) {
        setTimeout(() => {
          spawnSsh(args, retries - 1, timeoutMs).then(resolve);
        }, 1000);
        return;
      }

      resolve({ stdout: stdout || "", stderr: stderr || "", exitCode });
    });
  });
}

export interface SshExecOptions {
  // Cold login + a media batch easily exceeds the default 30s; callers doing
  // media work pass a larger budget here.
  timeoutMs?: number;
}

export async function sshRawExec(
  remote: RemoteConfig,
  command: string,
  opts?: SshExecOptions,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const args = [...sshControlArgs(), remote.host, command];
  return spawnSsh(args, 1, opts?.timeoutMs ?? DEFAULT_SSH_TIMEOUT);
}

export async function sshWuExec(
  remote: RemoteConfig,
  wuArgs: string[],
  opts?: SshExecOptions,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const escaped = wuArgs.map(shellEscape).join(" ");
  const command = `env WU_HOME=${remotePath(remote.wu_home)} wu ${escaped}`;
  return sshRawExec(remote, command, opts);
}

// Pull media files downloaded on the remote back to the local media dir so the
// client actually has the bytes. rsync only transfers what's missing.
export async function syncMedia(
  remote: RemoteConfig,
  localMediaDir: string,
): Promise<{ method: string }> {
  const remoteMediaDir = `${remote.host}:${remote.wu_home.replace(/\/+$/, "")}/media/`;
  return new Promise((resolve, reject) => {
    execFile(
      "rsync",
      ["-az", "--ignore-existing", remoteMediaDir, localMediaDir.replace(/\/+$/, "") + "/"],
      { timeout: 300_000 },
      (err) => {
        if (err) reject(new Error(`media rsync failed: ${(err as Error).message}`));
        else resolve({ method: "rsync" });
      },
    );
  });
}

// --- DB sync ---

export async function syncDb(
  remote: RemoteConfig,
  localDbPath: string,
): Promise<{ method: string }> {
  // Path 1: sqlite3-rsync (preferred)
  const localHas = (() => {
    try { execFileSync("which", ["sqlite3-rsync"], { stdio: "pipe" }); return true; } catch { return false; }
  })();

  if (localHas) {
    const remoteHas = await sshRawExec(remote, "which sqlite3-rsync");
    if (remoteHas.exitCode === 0) {
      const remoteDbPath = `${remote.wu_home}/wu.db`;
      return new Promise((resolve, reject) => {
        execFile(
          "sqlite3-rsync",
          [`${remote.host}:${remoteDbPath}`, localDbPath],
          { timeout: 120_000 },
          (err) => {
            if (err) reject(new Error(`sqlite3-rsync failed: ${(err as Error).message}`));
            else resolve({ method: "sqlite3-rsync" });
          },
        );
      });
    }
  }

  // Path 2: backup + rsync (fallback)
  const tmpRemote = `/tmp/wu-sync-${Date.now()}.db`;

  // Remote backup (use remotePath for tilde expansion)
  const backup = await sshRawExec(
    remote,
    `sqlite3 ${remotePath(remote.wu_home + "/wu.db")} '.backup ${shellEscape(tmpRemote)}'`,
  );
  if (backup.exitCode !== 0) {
    throw new Error(`Remote backup failed: ${backup.stderr}`);
  }

  // Rsync to local temp file
  const tmpLocal = localDbPath + ".tmp";
  const sshCmd = `ssh ${sshControlArgs().join(" ")}`;

  await new Promise<void>((resolve, reject) => {
    execFile(
      "rsync",
      ["-az", "-e", sshCmd, `${remote.host}:${tmpRemote}`, tmpLocal],
      { timeout: 120_000 },
      (err) => {
        if (err) reject(new Error(`rsync failed: ${(err as Error).message}`));
        else resolve();
      },
    );
  });

  // Atomic local write
  for (const suffix of ["-wal", "-shm"]) {
    try { unlinkSync(localDbPath + suffix); } catch {}
  }
  renameSync(tmpLocal, localDbPath);

  // Clean up remote temp
  await sshRawExec(remote, `rm -f ${shellEscape(tmpRemote)}`);

  return { method: "backup+rsync" };
}

// --- Default remote resolution ---

export function getDefaultRemote(
  config: WuConfig,
): { name: string; remote: RemoteConfig } | undefined {
  const remotes = config.remotes;
  if (!remotes) return undefined;

  const names = Object.keys(remotes);
  if (names.length === 0) return undefined;

  // Explicit default
  if (config.default_remote && remotes[config.default_remote]) {
    return { name: config.default_remote, remote: remotes[config.default_remote] };
  }

  // Single remote
  if (names.length === 1) {
    return { name: names[0], remote: remotes[names[0]] };
  }

  // Multiple + no default
  return undefined;
}

// --- Remote health check ---

export async function checkRemoteHealth(
  remote: RemoteConfig,
): Promise<{
  reachable: boolean;
  wuInstalled: boolean;
  daemonRunning: boolean;
}> {
  const result = await sshWuExec(remote, ["status", "--json"]);

  if (result.exitCode === 0) {
    try {
      const parsed = JSON.parse(result.stdout);
      return {
        reachable: true,
        wuInstalled: true,
        daemonRunning: !!parsed.daemon_running,
      };
    } catch {
      return { reachable: true, wuInstalled: true, daemonRunning: false };
    }
  }

  // Distinguish unreachable vs wu not installed
  const echo = await sshRawExec(remote, "echo ok");
  if (echo.exitCode === 0 && echo.stdout.trim() === "ok") {
    return { reachable: true, wuInstalled: false, daemonRunning: false };
  }

  return { reachable: false, wuInstalled: false, daemonRunning: false };
}
