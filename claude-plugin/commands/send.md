---
description: Send a WhatsApp message
argument-hint: <jid> <message>
allowed-tools: mcp__wu__wu_messages_send, mcp__wu__wu_chats_search, mcp__wu__wu_contacts_search
---

Send a WhatsApp message using the wu MCP server.

Arguments: $ARGUMENTS

If the user provided a JID and message, send it directly. If only a message or contact name is given, first use `wu_chats_search` (preferred, searches by chat name) or `wu_contacts_search` (by contact name/phone) to find the JID, then send.

If the send fails:
- `Remote send failed: ...`: wu is in remote mode and SSH or the remote daemon errored. Run `/wu-status` to confirm the remote daemon is reachable. The user may need to restart the remote daemon (e.g. `systemctl --user restart wu` on their VPS).
- `Constraint violation: ...`: the chat is read-only or blocked. Tell the user to run `wu config allow <jid>` if they want Claude to send there.
- `Not connected to WhatsApp and no remote configured`: neither a local connection nor a remote is set up. Direct them to `wu login` (local) or `wu remote add` (VPS).
