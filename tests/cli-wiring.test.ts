import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Command } from "commander";
import {
  EXIT_SUCCESS,
  EXIT_GENERAL_ERROR,
  EXIT_CONSTRAINT_VIOLATION,
  EXIT_NOT_AUTHENTICATED,
  EXIT_CONNECTION_FAILED,
  EXIT_NOT_FOUND,
} from "../src/cli/exit-codes.js";

// src/cli/index.ts calls ensureWuHome() and program.parseAsync(process.argv)
// at import time, so it can't be imported directly in a test. Every other
// cli/*.ts file only exports a register*Command(program) function with no
// top-level side effects - build the same command tree index.ts builds and
// inspect it without ever calling .parseAsync() or invoking an action, so no
// action that opens a WhatsApp connection ever runs.
const home = mkdtempSync(join(tmpdir(), "wu-cli-wiring-"));
process.env.WU_HOME = home;
mkdirSync(join(home, "auth"), { recursive: true });

let program: Command;

before(async () => {
  const { registerConfigCommand } = await import("../src/cli/config.js");
  const { registerLoginCommand } = await import("../src/cli/login.js");
  const { registerStatusCommand } = await import("../src/cli/status.js");
  const { registerChatsCommand } = await import("../src/cli/chats.js");
  const { registerMessagesCommand } = await import("../src/cli/messages.js");
  const { registerContactsCommand } = await import("../src/cli/contacts.js");
  const { registerGroupsCommand } = await import("../src/cli/groups.js");
  const { registerCommunitiesCommand } = await import("../src/cli/communities.js");
  const { registerDmsCommand } = await import("../src/cli/dms.js");
  const { registerMediaCommand } = await import("../src/cli/media.js");
  const { registerEnrichCommand } = await import("../src/cli/enrich.js");
  const { registerListenCommand } = await import("../src/cli/listen.js");
  const { registerDaemonCommand } = await import("../src/cli/daemon.js");
  const { registerDbCommand } = await import("../src/cli/db.js");
  const { registerMcpCommand } = await import("../src/cli/mcp.js");
  const { registerHistoryCommand } = await import("../src/cli/history.js");
  const { registerRemoteCommand } = await import("../src/cli/remote.js");
  const { registerSyncCommand } = await import("../src/cli/sync.js");

  program = new Command();
  registerConfigCommand(program);
  registerLoginCommand(program);
  registerStatusCommand(program);
  registerChatsCommand(program);
  registerMessagesCommand(program);
  registerContactsCommand(program);
  registerGroupsCommand(program);
  registerCommunitiesCommand(program);
  registerDmsCommand(program);
  registerMediaCommand(program);
  registerEnrichCommand(program);
  registerHistoryCommand(program);
  registerListenCommand(program);
  registerDaemonCommand(program);
  registerDbCommand(program);
  registerMcpCommand(program);
  registerRemoteCommand(program);
  registerSyncCommand(program);
});

after(() => {
  rmSync(home, { recursive: true, force: true });
});

function sub(name: string): Command {
  const cmd = program.commands.find((c) => c.name() === name);
  assert.ok(cmd, `expected a "${name}" command to be registered`);
  return cmd!;
}

function child(parent: Command, name: string): Command {
  const cmd = parent.commands.find((c) => c.name() === name);
  assert.ok(cmd, `expected "${parent.name()} ${name}" to be registered`);
  return cmd!;
}

function optionDefault(cmd: Command, long: string): unknown {
  const opt = cmd.options.find((o) => o.long === long);
  assert.ok(opt, `expected ${cmd.name()} to have option ${long}`);
  return opt!.defaultValue;
}

function argRequired(cmd: Command, name: string): boolean {
  const arg = cmd.registeredArguments.find((a) => a.name() === name);
  assert.ok(arg, `expected ${cmd.name()} to have arg <${name}>`);
  return arg!.required;
}

describe("CLI command tree - top level", () => {
  it("registers every top-level command index.ts wires up", () => {
    const names = program.commands.map((c) => c.name()).sort();
    assert.deepEqual(names, [
      "chats",
      "communities",
      "config",
      "contacts",
      "daemon",
      "db",
      "dms",
      "enrich",
      "groups",
      "history",
      "listen",
      "login",
      "logout",
      "media",
      "mcp",
      "messages",
      "remote",
      "status",
      "sync",
    ].sort());
  });
});

describe("CLI command tree - chats", () => {
  it("list defaults --limit to 100 and offers --json", () => {
    const list = child(sub("chats"), "list");
    assert.equal(optionDefault(list, "--limit"), "100");
    assert.ok(list.options.some((o) => o.long === "--json"));
  });

  it("search takes a required <query> argument", () => {
    const search = child(sub("chats"), "search");
    assert.equal(argRequired(search, "query"), true);
  });
});

describe("CLI command tree - messages", () => {
  it("list takes a required <jid> and defaults --limit to 50", () => {
    const list = child(sub("messages"), "list");
    assert.equal(argRequired(list, "jid"), true);
    assert.equal(optionDefault(list, "--limit"), "50");
  });

  it("send takes a required <jid> and an optional [text], plus media/poll flags", () => {
    const send = child(sub("messages"), "send");
    assert.equal(argRequired(send, "jid"), true);
    assert.equal(argRequired(send, "text"), false);
    for (const flag of ["--media", "--caption", "--reply-to", "--poll", "--options"]) {
      assert.ok(send.options.some((o) => o.long === flag), `expected messages send to have ${flag}`);
    }
  });

  it("react takes three required positional args", () => {
    const react = child(sub("messages"), "react");
    assert.equal(argRequired(react, "jid"), true);
    assert.equal(argRequired(react, "msg-id"), true);
    assert.equal(argRequired(react, "emoji"), true);
  });
});

describe("CLI command tree - media", () => {
  it("download-batch defaults --limit to 50 and --concurrency to 4", () => {
    const batch = child(sub("media"), "download-batch");
    assert.equal(optionDefault(batch, "--limit"), "50");
    assert.equal(optionDefault(batch, "--concurrency"), "4");
  });

  it("prune offers --older-than, --chat, --dry-run, --json with no required args", () => {
    const prune = child(sub("media"), "prune");
    assert.equal(prune.registeredArguments.length, 0);
    for (const flag of ["--older-than", "--chat", "--dry-run", "--json"]) {
      assert.ok(prune.options.some((o) => o.long === flag));
    }
  });
});

describe("CLI command tree - db", () => {
  it("reset offers -y/--yes to skip confirmation", () => {
    const reset = child(sub("db"), "reset");
    assert.ok(reset.options.some((o) => o.long === "--yes" && o.short === "-y"));
  });

  it("vacuum and reindex take no arguments", () => {
    const dbCmd = sub("db");
    assert.equal(child(dbCmd, "vacuum").registeredArguments.length, 0);
    assert.equal(child(dbCmd, "reindex").registeredArguments.length, 0);
  });
});

describe("CLI command tree - daemon", () => {
  it("has install/uninstall/logs subcommands alongside its own action", () => {
    const daemon = sub("daemon");
    assert.ok(daemon.commands.some((c) => c.name() === "install"));
    assert.ok(daemon.commands.some((c) => c.name() === "uninstall"));
    assert.ok(daemon.commands.some((c) => c.name() === "logs"));
  });
});

describe("CLI command tree - sync", () => {
  it("pull offers --watch and --interval defaulting to 30", () => {
    const pull = child(sub("sync"), "pull");
    assert.ok(pull.options.some((o) => o.long === "--watch"));
    assert.equal(optionDefault(pull, "--interval"), "30");
  });

  it("install defaults --interval to 60", () => {
    const install = child(sub("sync"), "install");
    assert.equal(optionDefault(install, "--interval"), "60");
  });
});

describe("CLI command tree - config constraint commands", () => {
  it("allow defaults --mode to full", () => {
    const allow = child(sub("config"), "allow");
    assert.equal(optionDefault(allow, "--mode"), "full");
  });

  it("default takes an optional [mode]", () => {
    const def = child(sub("config"), "default");
    assert.equal(argRequired(def, "mode"), false);
  });
});

describe("CLI exit codes", () => {
  it("are distinct, stable integers", () => {
    const codes = {
      EXIT_SUCCESS,
      EXIT_GENERAL_ERROR,
      EXIT_CONSTRAINT_VIOLATION,
      EXIT_NOT_AUTHENTICATED,
      EXIT_CONNECTION_FAILED,
      EXIT_NOT_FOUND,
    };
    assert.deepEqual(codes, {
      EXIT_SUCCESS: 0,
      EXIT_GENERAL_ERROR: 1,
      EXIT_CONSTRAINT_VIOLATION: 2,
      EXIT_NOT_AUTHENTICATED: 3,
      EXIT_CONNECTION_FAILED: 4,
      EXIT_NOT_FOUND: 5,
    });
  });
});
