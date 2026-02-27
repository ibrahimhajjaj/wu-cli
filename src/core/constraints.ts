import type { WuConfig, ConstraintMode } from "../config/schema.js";

export function resolveConstraint(
  jid: string,
  config: WuConfig
): ConstraintMode {
  if (!config.constraints) return "none";

  const chats = config.constraints.chats;

  // 1. Exact JID match
  if (chats[jid]) return chats[jid].mode;

  // 2. Wildcard match
  const domain = jid.includes("@") ? jid.substring(jid.indexOf("@")) : "";
  const wildcard = `*${domain}`;
  if (chats[wildcard]) return chats[wildcard].mode;

  // 3. Default
  return config.constraints.default;
}

export function assertCanSend(jid: string, config: WuConfig): void {
  const mode = resolveConstraint(jid, config);
  if (mode !== "full") {
    const err = new Error(
      `Constraint violation: chat ${jid} is ${mode === "read" ? "read-only" : "blocked (none)"}`
    );
    (err as Error & { exitCode: number }).exitCode = 2;
    throw err;
  }
}

export function assertCanManage(jid: string, config: WuConfig): void {
  assertCanSend(jid, config);
}

export function shouldCollect(jid: string, config: WuConfig): boolean {
  const mode = resolveConstraint(jid, config);
  return mode !== "none";
}
