---
description: List WhatsApp Communities and their subgroups
allowed-tools: mcp__wu__wu_communities_list, mcp__wu__wu_groups_list
---

List WhatsApp Communities (parent groups that contain subgroups) using the wu MCP server.

Call `wu_communities_list` with `with_subgroups: true` when the user wants the full hierarchy, or default (false) when they just want to see which communities they're in. Each community row includes its `constraint` state.

Render as a tree: community parent on its own line, subgroups indented underneath with their tag (`announce` for the announcement channel, `subgroup` for the rest).

If the cache is empty, suggest the user run `wu groups list --live` once or start `wu daemon` so groups get populated as events arrive.
