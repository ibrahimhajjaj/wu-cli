import { Command } from "commander";
import { listCommunities, listGroups } from "../core/store.js";
import { loadConfig } from "../config/schema.js";
import { resolveConstraint } from "../core/constraints.js";
import { outputResult } from "./format.js";

export function registerCommunitiesCommand(program: Command): void {
  const communities = program
    .command("communities")
    .description("List WhatsApp Communities (parent groups containing subgroups)");

  communities
    .command("list")
    .description("List all known communities")
    .option("--limit <n>", "Max communities to show", "100")
    .option("--with-subgroups", "Include subgroups under each community")
    .option("--json", "Output as JSON")
    .action(
      (opts: { limit: string; withSubgroups?: boolean; json?: boolean }) => {
        const config = loadConfig();
        const limit = parseInt(opts.limit, 10);
        const parents = listCommunities({ limit }).slice(0, limit);

        if (parents.length === 0) {
          console.log(
            "No communities cached. Run `wu groups list --live` once to fetch from WhatsApp, " +
              "or start `wu daemon` to populate as events arrive."
          );
          return;
        }

        const allGroups = opts.withSubgroups ? listGroups({ limit: 10000 }) : [];
        const childrenByParent = new Map<string, typeof allGroups>();
        for (const g of allGroups) {
          if (g.linked_parent) {
            const list = childrenByParent.get(g.linked_parent) || [];
            list.push(g);
            childrenByParent.set(g.linked_parent, list);
          }
        }

        if (opts.json) {
          outputResult(
            parents.map((p) => ({
              jid: p.jid,
              name: p.name,
              constraint: resolveConstraint(p.jid, config),
              subgroups: opts.withSubgroups
                ? (childrenByParent.get(p.jid) || []).map((c) => ({
                    jid: c.jid,
                    name: c.name,
                    is_announce: c.is_community_announce === 1,
                    constraint: resolveConstraint(c.jid, config),
                  }))
                : undefined,
            })),
            { json: true }
          );
          return;
        }

        for (const p of parents) {
          const status = resolveConstraint(p.jid, config);
          console.log(`${p.name || p.jid}  [${status}]  ${p.jid}`);
          if (opts.withSubgroups) {
            const kids = childrenByParent.get(p.jid) || [];
            for (const k of kids) {
              const tag = k.is_community_announce === 1 ? "announce" : "subgroup";
              const kStatus = resolveConstraint(k.jid, config);
              console.log(`  └─ ${k.name || k.jid}  [${tag}] [${kStatus}]  ${k.jid}`);
            }
          }
        }
      }
    );
}
