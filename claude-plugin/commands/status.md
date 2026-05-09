---
description: Check WhatsApp connection status
allowed-tools: mcp__wu__wu_status
---

Check WhatsApp connection status using the wu MCP server.

Call `wu_status` and interpret the result based on the `mode` field:

- **`mode: "local"`**: this MCP process owns the WhatsApp session directly. `connected` reflects the live socket state.
- **`mode: "local-daemon"`**: a local `wu daemon` owns the session; this MCP is read-only. `connected` will be `null` because we can't observe the daemon's socket from here. Tell the user the daemon is running and to check `wu status` from a terminal for live socket state. Do NOT report "WhatsApp not connected"; that's only true if the daemon itself is down.
- **`mode: "remote"`**: a remote daemon (over SSH) owns the session. `connected` reflects whether the remote daemon's `wu status` reports `daemon_running: true`. `messages_stored` is from the LOCAL synced DB and may be stale relative to the remote; say so when freshness matters. If `error` is present, the remote was unreachable; report the error verbatim.

Always report the mode explicitly so the user knows where the data is coming from. If `mode` is `remote`, mention the `remote_name` and `remote_host`.
