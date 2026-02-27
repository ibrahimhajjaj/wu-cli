---
description: List messages in a WhatsApp chat
argument-hint: <jid or chat name>
allowed-tools: mcp__wu__wu_messages_list, mcp__wu__wu_chats_list
---

List recent messages in a WhatsApp chat using the wu MCP server.

Chat: $ARGUMENTS

If the user provided a chat name instead of a JID, first use wu_chats_list to find the matching JID. Then list messages in a readable format with timestamps and sender names.
