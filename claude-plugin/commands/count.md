---
description: Count WhatsApp messages in a chat
argument-hint: <jid or chat name> [--after timestamp]
allowed-tools: mcp__wu__wu_messages_count, mcp__wu__wu_chats_list
---

Count messages in a WhatsApp chat using the wu MCP server.

Chat: $ARGUMENTS

If the user provided a chat name instead of a JID, first use wu_chats_list to find the matching JID. Then use wu_messages_count to get the count with any provided filters. Report the count clearly.
