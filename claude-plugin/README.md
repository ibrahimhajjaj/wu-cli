# wu-whatsapp — Claude Code Plugin

WhatsApp integration for Claude Code. Send messages, search chats, list contacts, and more — all from Claude Code.

## Install

```bash
# Clone the repo and point Claude Code to the plugin directory
git clone https://github.com/ibrahimhajjaj/wu-cli.git
claude --plugin-dir ./wu-cli/claude-plugin
```

Or from inside Claude Code:
```
/plugin install wu-whatsapp
```

## Prerequisites

1. Install wu-cli: `npm install -g @ibrahimwithi/wu-cli`
2. Login to WhatsApp: `wu login`
3. Configure constraints for the chats you want Claude to access (see [Getting Started](../docs/getting-started.md#step-2-configure-constraints))

## Commands

| Command | Description |
|---|---|
| `/wu-send <jid> <message>` | Send a WhatsApp message |
| `/wu-search <query>` | Search messages |
| `/wu-messages <jid>` | List messages in a chat |
| `/wu-chats` | List all chats |
| `/wu-contacts` | List all contacts |
| `/wu-react <jid> <id> <emoji>` | React to a message |
| `/wu-status` | Check connection status |

## How It Works

The plugin starts `wu mcp` as an MCP server, giving Claude access to WhatsApp tools and resources. The slash commands are shortcuts that guide Claude to use the right tools with the right arguments.

All actions respect the constraint system — Claude can only interact with chats you've explicitly allowed.
