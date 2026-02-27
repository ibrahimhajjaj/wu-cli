# wu

WhatsApp CLI tool — like `gh` is to GitHub, `wu` is to WhatsApp.

Built on [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys).

## Install

```bash
npm install -g @ibrahimwithi/wu-cli
```

Requires Node.js 20+.

## Quick Start

```bash
# Authenticate (scan QR code)
wu login

# Or use pairing code instead
wu login --code 15551234567

# Start collecting messages
wu listen

# Search messages
wu messages search "meeting tomorrow"

# Send a message
wu messages send 1234567890@s.whatsapp.net "Hello!"

# List your groups
wu groups list --live
```

By default, wu operates in **opt-in mode** — no messages are collected until you allow specific chats:

```bash
# Allow all group messages (read-only)
wu config allow '*@g.us' --mode read

# Allow full access to a specific chat
wu config allow 1234567890@s.whatsapp.net

# Start collecting
wu listen
```

## Commands

### Authentication

| Command | Description |
|---|---|
| `wu login` | Authenticate with WhatsApp via QR code |
| `wu login --code <phone>` | Authenticate via pairing code |
| `wu logout` | Clear session |
| `wu status` | Show connection status and account info |

### Messages

| Command | Description |
|---|---|
| `wu messages list <jid>` | List messages in a chat |
| `wu messages search <query>` | Search messages by text |
| `wu messages send <jid> [text]` | Send text, media, or poll |
| `wu messages react <jid> <id> <emoji>` | React to a message |
| `wu messages delete <jid> <id>` | Delete a message for everyone |

```bash
# Send with media
wu messages send 1234567890@s.whatsapp.net --media photo.jpg --caption "Check this out"

# Create a poll
wu messages send 120363XXX@g.us --poll "Lunch?" --options "Pizza,Sushi,Tacos"

# Reply to a message
wu messages send 120363XXX@g.us "Agreed" --reply-to BAE5ABC123

# Search within a specific chat
wu messages search "budget" --chat 120363XXX@g.us --limit 20
```

### Chats & Contacts

| Command | Description |
|---|---|
| `wu chats list` | List all chats |
| `wu chats search <query>` | Search chats by name |
| `wu contacts list` | List all contacts |
| `wu contacts search <query>` | Search contacts by name or phone |
| `wu contacts info <jid>` | Show contact details |

### Groups

| Command | Description |
|---|---|
| `wu groups list` | List groups (cached) |
| `wu groups list --live` | Fetch groups from WhatsApp |
| `wu groups info <jid>` | Show group details and participants |
| `wu groups create <name> [jids...]` | Create a new group |
| `wu groups invite <jid>` | Get invite link |
| `wu groups leave <jid>` | Leave a group |
| `wu groups participants <jid>` | List group participants |

### Media

| Command | Description |
|---|---|
| `wu media download <msg-id>` | Download media from a message |
| `wu media send <jid> <path>` | Send a media file |

### Daemon

```bash
# Run as a foreground daemon — collects messages continuously
wu daemon
```

The daemon auto-reconnects on connection drops, logs health every 5 minutes, and stores all messages to SQLite.

### MCP Server

```bash
# Start MCP server (stdio transport for AI agents)
wu mcp
```

Exposes WhatsApp as tools and resources for AI agents via the [Model Context Protocol](https://modelcontextprotocol.io). See [MCP setup guide](docs/mcp-setup.md) for Claude Code, Cursor, Codex CLI, and Gemini CLI configuration.

### Configuration

| Command | Description |
|---|---|
| `wu config show` | Print current config (YAML) |
| `wu config set <path> <value>` | Set a config value (dot-notation) |
| `wu config path` | Print config file path |
| `wu config allow <jid>` | Allow a chat (default: full access) |
| `wu config block <jid>` | Block a chat (drop all messages) |
| `wu config remove <jid>` | Remove a per-chat constraint |
| `wu config default [mode]` | Get/set default constraint mode |
| `wu config constraints` | Show all constraints |

### Database

| Command | Description |
|---|---|
| `wu db vacuum` | Run VACUUM and ANALYZE |

## Constraints

The constraint system controls what wu can do with each chat. Three modes:

| Mode | Collect messages | Send messages | Manage group |
|---|---|---|---|
| `full` | yes | yes | yes |
| `read` | yes | no | no |
| `none` | no | no | no |

Resolution order (most specific wins):
1. Exact JID match (`1234567890@s.whatsapp.net`)
2. Wildcard domain (`*@g.us` for all groups, `*@s.whatsapp.net` for all DMs)
3. Default constraint
4. Implicit fallback: `none`

```bash
# Set default to read-only for everything
wu config default read

# Full access for one group
wu config allow 120363XXX@g.us

# Block a specific chat
wu config block 1234567890@s.whatsapp.net

# Read-only for all groups
wu config allow '*@g.us' --mode read
```

## Configuration

Config lives at `~/.wu/config.yaml`:

```yaml
whatsapp:
  read_receipts: false     # Send read receipts (default: false)
  media_max_mb: 50         # Max media auto-download size in MB
  send_delay_ms: 1000      # Delay before sending messages (ms)

constraints:
  default: none            # Default constraint mode
  chats:
    "*@g.us":
      mode: read
    "120363XXX@g.us":
      mode: full

db:
  path: ~/.wu/wu.db        # SQLite database path

log:
  level: info              # debug, info, warn, error
```

All runtime data lives under `~/.wu/` (override with `WU_HOME` env var).

## JSON Output

Most commands support `--json` for machine-readable output. When piped, `wu listen` auto-detects and switches to JSON:

```bash
# Pipe messages to jq
wu listen | jq '.body'

# Export messages as JSON
wu messages list 120363XXX@g.us --json --limit 1000
```

## MCP Tools and Resources

When running `wu mcp`, the following are available to AI agents:

**Tools:** `wu_messages_send`, `wu_react`, `wu_media_download`, `wu_groups_create`, `wu_groups_leave`, `wu_messages_search`, `wu_chats_list`, `wu_messages_list`, `wu_contacts_list`, `wu_status`

**Resources:** `wu://chats`, `wu://chats/{jid}/messages`, `wu://contacts`, `wu://contacts/{jid}`, `wu://groups`, `wu://groups/{jid}`, `wu://status`

## Exit Codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | General error |
| 2 | Constraint violation |
| 3 | Not authenticated |
| 4 | Connection failed |
| 5 | Not found |

## License

MIT
