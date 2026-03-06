---
description: Export WhatsApp messages to a file
argument-hint: <jid or chat name> [--after timestamp] [--format jsonl|json|markdown|csv]
allowed-tools: mcp__wu__wu_messages_export, mcp__wu__wu_chats_list, mcp__wu__wu_messages_count
---

Export WhatsApp messages to a file using the wu MCP server.

Chat: $ARGUMENTS

If the user provided a chat name instead of a JID, first use wu_chats_list to find the matching JID. Use wu_messages_count first to check message volume. Then export using wu_messages_export with the appropriate format and output path. Report the summary (message count, file size, path) when done.
