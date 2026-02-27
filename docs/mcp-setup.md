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
| `wu_react` | React to a message with an emoji |
| `wu_media_download` | Download media from a message |
| `wu_groups_create` | Create a new group |
| `wu_groups_leave` | Leave a group |
| `wu_messages_search` | Search messages by text |
| `wu_chats_list` | List all chats |
| `wu_messages_list` | List messages in a chat |
| `wu_contacts_list` | List all contacts |
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

## Prerequisites

Before using `wu mcp`, make sure you've:

1. Installed wu: `npm install -g @ibrahimwithi/wu-cli`
2. Logged in: `wu login`
3. Configured constraints for the chats you want the AI to access (see [Getting Started](getting-started.md#step-2-configure-constraints))
