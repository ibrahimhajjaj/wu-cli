// Shared read path between the MCP tools (src/mcp/tools.ts) and the CLI read
// commands (src/cli/{chats,dms,messages,communities,groups}.ts). Both used to
// independently re-implement the same query -> constraint-filter -> shape
// pipeline, hand-rolling `.filter(shouldCollect).slice(limit)` after fetching
// up to `limit: 10000` rows from SQLite. This module is now the one place
// that pipeline lives; each adapter still owns its own output shaping (JSON
// for MCP, formatted text/JSON for the CLI) and its own gate error message.
//
// Constraint-in-SQL strategy (chosen strategy, see plans/012): the
// constraints config is small (a `default` mode plus a handful of per-chat
// entries) and lives entirely in the on-disk config, not the DB, so at query
// time it unrolls into a parameterized SQL CASE expression instead of a JS
// post-filter over an over-fetched row set. See
// core/constraints.ts:constraintSqlPredicate for the translation and
// core/store.ts's `*Where` functions for how it's applied - a pure-SQL
// translation turned out to be fully feasible (exact JID / wildcard domain /
// default all reduce to bounded IN-lists), so there was no need to fall back
// to the bounded-fetch-plus-JS-filter compromise.
//
// The one read path that stays JS-side is the *live* group listing
// (wu_groups_list --live / wu_groups_list live:true): that data comes
// straight off the WhatsApp socket, never touches SQLite, and the result set
// is small enough that a JS filter is the right tool.
//
// Row ordering: MCP and CLI had already drifted on how groups/communities are
// ordered before this refactor (MCP via listChats's last_message_at order,
// CLI via listGroups's name order). Rather than silently unify them - which
// would change one side's existing output - the functions below take an
// explicit `order` so each adapter keeps its historic ordering.

import type { WuConfig } from "../config/schema.js";
import { shouldCollect, constraintSqlPredicate } from "./constraints.js";
import {
  listChatsWhere,
  searchChatsWhere,
  listDmsWhere,
  listGroupsWhere,
  listGroupsByLinkedParent,
  listMessages,
  searchMessages,
  getChatByJid,
  type ChatRow,
  type MessageRow,
  type SearchResult,
} from "./store.js";

const UNFILTERED = { sql: "1", params: [] as unknown[] };

export function listChatsForConfig(
  config: WuConfig,
  opts: { limit: number }
): ChatRow[] {
  return listChatsWhere(constraintSqlPredicate("jid", config), { limit: opts.limit });
}

export function searchChatsForConfig(
  config: WuConfig,
  query: string,
  opts: { limit: number }
): ChatRow[] {
  return searchChatsWhere(query, constraintSqlPredicate("jid", config), {
    limit: opts.limit,
  });
}

export function listDmsForConfig(
  config: WuConfig,
  opts: { limit: number; includeBlocked?: boolean }
): ChatRow[] {
  const predicate = opts.includeBlocked
    ? UNFILTERED
    : constraintSqlPredicate("jid", config);
  return listDmsWhere(predicate, { limit: opts.limit });
}

export function listGroupsForConfig(
  config: WuConfig,
  opts: { limit: number; allowedOnly?: boolean; order?: "recency" | "name" }
): ChatRow[] {
  const predicate = opts.allowedOnly
    ? constraintSqlPredicate("jid", config)
    : UNFILTERED;
  return listGroupsWhere(predicate, { limit: opts.limit, order: opts.order });
}

// Single-group lookup by jid - replaces the old `listChats({limit:10000}).find(...)`
// pattern used by both wu_groups_info and `wu groups info`. Not
// constraint-aware itself; callers gate with shouldCollect() first so each
// adapter can keep its own "blocked" error message.
export function getChat(jid: string): ChatRow | undefined {
  return getChatByJid(jid);
}

export interface CommunitiesForConfig {
  parents: ChatRow[];
  childrenByParent: Map<string, ChatRow[]>;
}

// Communities are not constraint-gated in either adapter today (only
// annotated with their constraint mode), so no predicate is applied here -
// that matches existing wu_communities_list / `wu communities list` behavior.
export function listCommunitiesForConfig(
  config: WuConfig,
  opts: { limit: number; withSubgroups?: boolean; order?: "recency" | "name" }
): CommunitiesForConfig {
  void config; // kept for signature symmetry with the other *ForConfig functions
  const parents = listGroupsWhere(
    { sql: "is_community = 1", params: [] },
    { limit: opts.limit, order: opts.order }
  );
  const childrenByParent = new Map<string, ChatRow[]>();
  if (opts.withSubgroups && parents.length > 0) {
    const children = listGroupsByLinkedParent(
      parents.map((p) => p.jid),
      opts.order === "recency" ? "recency" : "name"
    );
    for (const c of children) {
      if (!c.linked_parent) continue;
      const list = childrenByParent.get(c.linked_parent) || [];
      list.push(c);
      childrenByParent.set(c.linked_parent, list);
    }
  }
  return { parents, childrenByParent };
}

// Returns null when the chat is blocked by constraints - callers render
// their own "blocked" message (MCP returns a JSON error, the CLI prints a
// `wu config allow` hint).
export function listMessagesForConfig(
  config: WuConfig,
  opts: { chatJid: string; limit?: number; before?: number; after?: number }
): MessageRow[] | null {
  if (!shouldCollect(opts.chatJid, config)) return null;
  return listMessages(opts);
}

export function searchMessagesForConfig(
  config: WuConfig,
  query: string,
  opts: {
    chatJid?: string;
    senderJid?: string;
    limit: number;
    after?: number;
    before?: number;
  }
): SearchResult[] {
  return searchMessages(query, {
    ...opts,
    visiblePredicate: constraintSqlPredicate("chat_jid", config),
  });
}
