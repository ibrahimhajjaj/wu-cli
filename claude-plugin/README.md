# wu-whatsapp — Claude Code Plugin

WhatsApp integration for Claude Code. Send messages, search chats, list contacts, and more — all from Claude Code.

## Install

From inside Claude Code:

```
/plugin marketplace add ibrahimhajjaj/wu-cli
/plugin install wu-whatsapp@wu-cli
```

## Prerequisites

1. Install wu-cli: `npm install -g @ibrahimwithi/wu-cli`
2. Authenticate, either:
   - **Local**: `wu login` (this machine holds the WhatsApp session)
   - **Remote (VPS)**: `wu remote add <name> <host>` then sync with `wu sync pull`. The daemon runs on the VPS, your machine reads from a synced SQLite copy, and writes (send/react/etc.) route back over SSH.
3. Configure constraints for the chats you want Claude to access (see [Getting Started](../docs/getting-started.md#step-2-configure-constraints))

## Commands

| Command | Description |
|---|---|
| `/wu-send <jid> <message>` | Send a WhatsApp message |
| `/wu-search <query>` | Search messages (FTS5 full-text search) |
| `/wu-messages <jid>` | List messages in a chat |
| `/wu-chats` | List all chats |
| `/wu-groups` | List groups with community structure |
| `/wu-communities` | List communities and their subgroups |
| `/wu-dms` | List 1:1 chats (constraint-gated) |
| `/wu-contacts` | List all contacts |
| `/wu-react <jid> <id> <emoji>` | React to a message |
| `/wu-status` | Check connection status |
| `/wu-context <message-id>` | Get surrounding messages for context |
| `/wu-backfill <jid>` | Backfill older message history |
| `/wu-export <jid>` | Export WhatsApp messages to a file |
| `/wu-count <jid>` | Count messages in a chat |

## How It Works

The plugin starts `wu mcp` as an MCP server, giving Claude access to WhatsApp tools and resources. The slash commands are shortcuts that guide Claude to use the right tools with the right arguments.

All actions respect the constraint system — Claude can only interact with chats you've explicitly allowed.

### Operating modes

The MCP server detects which setup you're in and adapts:

| Mode | When | Reads | Writes |
|---|---|---|---|
| **local** | No daemon, no remote | Live WhatsApp | Live WhatsApp |
| **local-daemon** | `wu daemon` is running on this machine | Local SQLite | Disabled (daemon owns the session) |
| **remote** | `wu remote add` configured + synced DB | Local synced SQLite | Routed via SSH to the remote daemon |

Use `/wu-status` any time you want to verify which mode is active and whether the WhatsApp connection (local or remote) is healthy. In **remote** mode, `messages_stored` reflects the last sync; run `wu sync pull` to refresh.
