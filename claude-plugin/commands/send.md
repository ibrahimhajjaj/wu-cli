---
description: Send a WhatsApp message
argument-hint: <jid> <message>
allowed-tools: mcp__wu__wu_messages_send
---

Send a WhatsApp message using the wu MCP server.

Arguments: $ARGUMENTS

If the user provided a JID and message, send it directly. If only a message or contact name is given, first use wu_chats_list or wu_contacts_list to find the correct JID, then send.
