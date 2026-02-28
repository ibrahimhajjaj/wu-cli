# MCP Server Setup

wu exposes WhatsApp as an MCP (Model Context Protocol) server, letting AI coding tools send messages, search chats, list contacts, and more — all through natural language.

```bash
wu mcp
```

This starts a stdio-based MCP server. Below is how to configure it in each tool.

## Claude Code

### Plugin (recommended)

The plugin gives you slash commands (`/wu-send`, `/wu-search`, `/wu-chats`, etc.) on top of the MCP tools:

```bash
# Clone and use --plugin-dir
git clone https://github.com/ibrahimhajjaj/wu-cli.git
claude --plugin-dir ./wu-cli/claude-plugin

# Or from inside Claude Code
/plugin install wu-whatsapp
```

See the [plugin README](../claude-plugin/README.md) for details.

### MCP only

```bash
claude mcp add wu -- wu mcp
```

Or add to `.mcp.json` in your project root (or `~/.claude/.mcp.json` globally):

```json
{
  "mcpServers": {
    "wu": {
      "command": "wu",
      "args": ["mcp"]
    }
  }
}
```

## Cursor

Add to `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "wu": {
      "command": "wu",
      "args": ["mcp"]
    }
  }
}
```

## OpenAI Codex CLI

```bash
codex mcp add wu wu mcp
```

Or add to `~/.codex/config.toml`:

```toml
[mcp_servers.wu]
command = "wu"
args = ["mcp"]
enabled = true
```

## Gemini CLI

```bash
gemini mcp add wu wu mcp
```

Or add to `.gemini/settings.json` in your project root (or `~/.gemini/settings.json` globally):

```json
{
  "mcpServers": {
    "wu": {
      "command": "wu",
      "args": ["mcp"]
    }
  }
}
```

## Available Tools

| Tool | Description |
|---|---|
| `wu_messages_send` | Send a text or media message |
| `wu_messages_search` | Search messages by text |
| `wu_messages_list` | List messages in a chat |
| `wu_react` | React to a message with an emoji |
| `wu_media_download` | Download media from a message |
| `wu_chats_list` | List all chats |
| `wu_chats_search` | Search chats by name |
| `wu_contacts_list` | List all contacts |
| `wu_contacts_search` | Search contacts by name or phone |
| `wu_groups_list` | List groups (cached or live) |
| `wu_groups_info` | Group details and participants |
| `wu_groups_invite` | Get group invite link |
| `wu_groups_create` | Create a new group |
| `wu_groups_leave` | Leave a group |
| `wu_constraints_list` | Show all constraints |
| `wu_constraints_set` | Allow/block a chat |
| `wu_constraints_remove` | Remove a per-chat constraint |
| `wu_constraints_default` | Get/set default constraint mode |
| `wu_config_show` | Show current configuration |
| `wu_status` | Get connection status |

## Available Resources

| URI | Description |
|---|---|
| `wu://chats` | All chats |
| `wu://chats/{jid}/messages` | Messages for a chat |
| `wu://contacts` | All contacts |
| `wu://contacts/{jid}` | Single contact |
| `wu://groups` | All groups |
| `wu://groups/{jid}` | Single group with participants |
| `wu://status` | Connection status |

## Operating Modes

The MCP server operates in three modes, detected automatically:

| Mode | Condition | Reads | Writes |
|---|---|---|---|
| **Full local** | No daemon running, no remote | WhatsApp (live) | WhatsApp (live) |
| **Read-only** | Local daemon running | SQLite | Disabled |
| **Remote** | Remote configured + synced DB | Local SQLite | SSH to remote |

In remote mode, write tools (`wu_messages_send`, `wu_react`, `wu_groups_create`, etc.) are routed through SSH to the VPS daemon. Read tools always query the local SQLite database. See [Remote Sync](getting-started.md#remote-sync-vps-setup) for setup.

## Prerequisites

Before using `wu mcp`, make sure you've:

1. Installed wu: `npm install -g @ibrahimwithi/wu-cli`
2. Logged in: `wu login` (or set up a [remote](getting-started.md#remote-sync-vps-setup) with `wu remote add`)
3. Configured constraints for the chats you want the AI to access (see [Getting Started](getting-started.md#step-2-configure-constraints))
