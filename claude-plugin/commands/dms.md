---
description: List 1:1 (direct message) WhatsApp chats
allowed-tools: mcp__wu__wu_dms_list, mcp__wu__wu_chats_search
---

List 1:1 WhatsApp chats using the wu MCP server.

DMs are constraint-gated by default — DM JIDs contain the contact's phone number, so the wu MCP only returns DMs the user has opted into via `wu config allow <jid>`. If the user explicitly asks "show me all DMs" or "what about the ones Claude can't see," pass `include_blocked: true`.

Show name, JID, last message time, and the `constraint` state (full / read / none). If the user wants to enable Claude for a specific DM, suggest `wu config allow <jid>`.
