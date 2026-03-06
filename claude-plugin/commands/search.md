---
description: Search WhatsApp messages
argument-hint: <query> [--chat jid] [--after timestamp] [--before timestamp]
allowed-tools: mcp__wu__wu_messages_search, mcp__wu__wu_chats_list
---

Search WhatsApp messages using the wu MCP server.

Search for: $ARGUMENTS

Use the `after` and `before` parameters to filter by date range when the user specifies a time period. Present results in a readable format with sender name, timestamp, and message body. If results reference a specific chat, mention the chat name.
