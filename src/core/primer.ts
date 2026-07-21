import type { WASocket } from "@whiskeysockets/baileys";
import type { WuConfig } from "../config/schema.js";
import { shouldCollect } from "./constraints.js";
import { backfillHistory } from "./backfill.js";
import { listChatsWithoutMessages, type MessagelessChat } from "./store.js";
import { createChildLogger } from "../config/logger.js";

const logger = createChildLogger("primer");

// How many older messages to request when priming. On-demand history is a
// request to the phone, so this is a best-effort ceiling, not a guarantee.
const PRIME_COUNT = 50;

// Only warn about a message-less allowed chat once its activity is at least
// this old - a group allowed seconds ago is expected to be empty until its
// first message lands and triggers a prime; that is not a gap.
const GAP_GRACE_SECONDS = 15 * 60;
// Ignore chats whose last activity predates this - stale history isn't a
// live collection failure worth flagging.
const GAP_WINDOW_SECONDS = 7 * 24 * 60 * 60;

// Groups allowed to collect but holding no stored messages yet, mapped to the
// unix-second moment the daemon started expecting to collect them (enrolled-at).
// Their first live message becomes the anchor an on-demand history fetch needs,
// so the daemon primes them the moment that message lands. Recomputed at
// startup and on every config reload, so `wu config allow` enrolls a group with
// no restart. The enrolled-at stamp is what lets the guardrail tell "history
// from before the group was allowed can't be recovered" (expected) apart from
// "live collection is failing" (real).
export function computePrimePending(config: WuConfig, enrolledAt: number): Map<string, number> {
  const map = new Map<string, number>();
  for (const c of listChatsWithoutMessages()) {
    if (c.type === "group" && shouldCollect(c.jid, config)) map.set(c.jid, enrolledAt);
  }
  return map;
}

// Best-effort recovery of a freshly-allowed group's older history so an anchor
// exists and the pre-allow gap is filled WHEN the phone answers the on-demand
// request. A zero/timeout result is the expected degraded case here (the phone
// may be offline or the account may not share history with this device), logged
// as info - forward collection continues regardless.
export async function primeGroup(
  sock: WASocket,
  jid: string,
  config: WuConfig
): Promise<void> {
  try {
    const result = await backfillHistory(sock, jid, PRIME_COUNT, config);
    if (result.newMessages > 0) {
      logger.info({ jid, recovered: result.newMessages }, "primed newly-allowed group");
    } else {
      logger.info(
        { jid },
        "prime returned no history (phone offline or history not shared); forward collection continues"
      );
    }
  } catch (err) {
    logger.warn({ jid, err: (err as Error).message }, "prime attempt failed");
  }
}

// Pending groups that saw activity AFTER they were enrolled but still stored
// zero messages - the genuine live-collection-failure signature. Gating on
// enrolled-at is what keeps this honest: activity predating the allow can't be
// backfilled (the on-demand prime is phone-gated) and must NOT be reported as a
// failure, or the guardrail cries wolf on every group allowed after it went
// quiet. `primePending` already encodes allowed + group-only + not-yet-
// collected; the grace window skips activity too fresh to have been stored yet.
export function findSilentGaps(
  primePending: Map<string, number>,
  now: number
): MessagelessChat[] {
  if (primePending.size === 0) return [];
  return listChatsWithoutMessages(now - GAP_WINDOW_SECONDS).filter((c) => {
    const enrolledAt = primePending.get(c.jid);
    return (
      enrolledAt != null &&
      c.last_message_at != null &&
      c.last_message_at > enrolledAt &&
      c.last_message_at <= now - GAP_GRACE_SECONDS
    );
  });
}
