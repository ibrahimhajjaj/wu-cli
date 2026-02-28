---
description: Backfill older message history
argument-hint: <jid>
allowed-tools: mcp__wu__wu_history_backfill, mcp__wu__wu_chats_list
---

Request older message history from WhatsApp for a chat using the wu MCP server.

Arguments: $ARGUMENTS

If the user provided a JID, backfill it directly. If they gave a chat name, first use wu_chats_list to find the correct JID, then backfill. Default count is 50 messages.
