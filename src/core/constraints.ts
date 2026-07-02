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

// --- SQL predicate translation ---
//
// The `chats` map (exact JIDs plus `*@domain` wildcards) lives entirely in
// the on-disk config, not the DB, and is small in practice - so at query
// time it can be unrolled into a parameterized SQL CASE expression instead
// of pulling every row into JS to run shouldCollect() on each one. Priority
// mirrors resolveConstraint exactly: exact JID match, then wildcard domain,
// then the default mode.

export interface SqlPredicate {
  /** A boolean SQL expression, safe to splice directly after WHERE / AND. */
  sql: string;
  /** Positional `?` params, in the order they appear in `sql`. */
  params: unknown[];
}

export function constraintSqlPredicate(
  jidColumn: string,
  config: WuConfig
): SqlPredicate {
  // No constraints block at all means every jid resolves to "none" (see
  // resolveConstraint above) - nothing is visible.
  if (!config.constraints) return { sql: "0", params: [] };

  const exactAllow: string[] = [];
  const exactDeny: string[] = [];
  const wildcardAllow: string[] = [];
  const wildcardDeny: string[] = [];

  for (const [key, entry] of Object.entries(config.constraints.chats)) {
    const visible = entry.mode !== "none";
    if (key.startsWith("*")) {
      (visible ? wildcardAllow : wildcardDeny).push(key.slice(1));
    } else {
      (visible ? exactAllow : exactDeny).push(key);
    }
  }

  const defaultVisible = config.constraints.default !== "none" ? 1 : 0;
  const domainExpr = `CASE WHEN instr(${jidColumn}, '@') > 0 THEN substr(${jidColumn}, instr(${jidColumn}, '@')) ELSE '' END`;

  const whens: string[] = [];
  const params: unknown[] = [];
  const addTier = (values: string[], expr: string, result: 0 | 1) => {
    if (values.length === 0) return;
    whens.push(`WHEN ${expr} IN (${values.map(() => "?").join(",")}) THEN ${result}`);
    params.push(...values);
  };

  // Exact JID beats wildcard, which beats the default - same order as
  // resolveConstraint's three lookup steps.
  addTier(exactDeny, jidColumn, 0);
  addTier(exactAllow, jidColumn, 1);
  addTier(wildcardDeny, domainExpr, 0);
  addTier(wildcardAllow, domainExpr, 1);

  if (whens.length === 0) return { sql: `${defaultVisible} = 1`, params: [] };
  return {
    sql: `(CASE ${whens.join(" ")} ELSE ${defaultVisible} END) = 1`,
    params,
  };
}
