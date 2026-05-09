---
description: List WhatsApp groups including community structure
allowed-tools: mcp__wu__wu_groups_list, mcp__wu__wu_groups_info
---

List WhatsApp groups using the wu MCP server.

By default `wu_groups_list` returns ALL known groups (the discovery surface) so the user can see JIDs to opt into via `wu config allow <jid>`. The `constraint` field tells you the current state: `full` (read+write), `read` (read-only), or `none` (not opted in).

Render the result so the user can see community structure:
- Group rows with `is_community: true` are community parents.
- Rows with `linked_parent: <parent-jid>` are subgroups; indent them under their parent.
- Rows where `is_community_announce: true` are the community's announcement channel — call them out separately.
- Plain groups (no `linked_parent`, not a community) go after the community trees.

If the user asks for "groups I'm in" without further qualification, show everything. If they ask for "groups Claude can read or send to," pass `allowed_only: true`.
