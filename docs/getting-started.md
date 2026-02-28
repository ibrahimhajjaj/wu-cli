# Getting Started with wu

This guide walks you through installing wu, authenticating with WhatsApp, and collecting your first messages.

## Prerequisites

- **Node.js 20+** — check with `node --version`
- **A WhatsApp account** with an active phone

## Installation

```bash
# Install globally
npm install -g @ibrahimwithi/wu-cli

# Or run from source
git clone https://github.com/ibrahimhajjaj/wu-cli.git
cd wu-cli
npm install
npm run build
npm link
```

For development:

```bash
npm run dev -- <command>   # Run without building
npm run build              # Compile TypeScript
npm test                   # Run tests
```

## Step 1: Login

Authenticate wu with your WhatsApp account. You have two options:

### QR Code (default)

```bash
wu login
```

A QR code will appear in your terminal. Open WhatsApp on your phone, go to **Settings > Linked Devices > Link a Device**, and scan the code.

### Pairing Code

If QR scanning doesn't work (e.g., SSH session), use a pairing code instead:

```bash
wu login --code 15551234567
```

Replace with your phone number including country code (no `+`). An 8-digit code will be printed — enter it in WhatsApp under **Linked Devices > Link a Device**.

### Verify

```bash
wu status
```

You should see your phone number and display name.

## Step 2: Configure Constraints

By default, wu is in **opt-in mode** — it won't collect or interact with any chats until you allow them. This is intentional: you control exactly what wu has access to.

### Allow specific chats

```bash
# Full access to a specific group (read + write + manage)
wu config allow 120363XXX@g.us

# Read-only for all groups (collect messages, no sending)
wu config allow '*@g.us' --mode read

# Full access to a specific DM
wu config allow 1234567890@s.whatsapp.net
```

### Common setups

**Monitor all groups, read-only:**
```bash
wu config default none
wu config allow '*@g.us' --mode read
```

**Full access to everything:**
```bash
wu config default full
```

**Full access to one group, block everything else:**
```bash
wu config default none
wu config allow 120363XXX@g.us
```

### View your constraints

```bash
wu config constraints
```

### JID format

WhatsApp identifies chats by JID (Jabber ID):
- **Groups:** `120363XXXXXXXXX@g.us`
- **DMs:** `1234567890@s.whatsapp.net` (phone number without `+`)
- **Wildcards:** `*@g.us` (all groups), `*@s.whatsapp.net` (all DMs)

To find JIDs, use `wu groups list --live` or `wu chats list` after collecting some messages.

## Step 3: Collect Messages

### One-off listening

Stream messages to your terminal:

```bash
wu listen
```

Messages appear as they arrive. Press `Ctrl+C` to stop. When piped, output switches to JSON automatically:

```bash
wu listen | jq '.body'
```

Filter to specific chats:

```bash
wu listen --chats 120363XXX@g.us,120363YYY@g.us
```

### Daemon mode

For continuous collection in the background:

```bash
wu daemon
```

The daemon:
- Auto-reconnects on connection drops (exponential backoff)
- Stores all messages to SQLite at `~/.wu/wu.db`
- Logs health metrics every 5 minutes
- Acquires a lock file to prevent conflicts

For running as a systemd service, see `wu-daemon.service` in the project root.

## Step 4: Query Your Data

Once messages are collected, query them offline (no WhatsApp connection needed):

```bash
# List chats you've collected
wu chats list

# Search messages
wu messages search "meeting"

# List messages in a chat
wu messages list 120363XXX@g.us --limit 100

# Search within a specific chat
wu messages search "budget" --chat 120363XXX@g.us

# List contacts
wu contacts list
```

All query commands support `--json` for machine-readable output.

## Step 5: Send Messages

Sending requires `full` constraint mode on the target chat.

```bash
# Send text
wu messages send 1234567890@s.whatsapp.net "Hello from wu!"

# Send media
wu messages send 120363XXX@g.us --media photo.jpg --caption "Check this"

# Create a poll
wu messages send 120363XXX@g.us --poll "Where for lunch?" --options "Pizza,Sushi,Tacos"

# React to a message
wu messages react 120363XXX@g.us BAE5ABC123 👍

# Reply to a message
wu messages send 120363XXX@g.us "Agreed" --reply-to BAE5ABC123
```

## Step 6: MCP Server (for AI Agents)

wu can act as an MCP server, letting AI agents interact with WhatsApp:

```bash
wu mcp
```

This starts a stdio-based MCP server that exposes tools (send messages, search, list chats) and resources (chat histories, contacts, groups) to any MCP-compatible client.

For setup instructions with **Claude Code**, **Cursor**, **Codex CLI**, and **Gemini CLI**, see the [MCP setup guide](mcp-setup.md).

## File Locations

| Path | Purpose |
|---|---|
| `~/.wu/config.yaml` | Configuration |
| `~/.wu/wu.db` | SQLite database |
| `~/.wu/auth/` | WhatsApp session credentials |
| `~/.wu/media/` | Downloaded media files |
| `~/.wu/wu.lock` | Daemon lock file |

Override the base directory with `WU_HOME`:

```bash
WU_HOME=/custom/path wu listen
```

## Next Steps

- Run `wu --help` or `wu <command> --help` for full command reference
- See the [README](../README.md) for the complete command table and constraint reference
- See the [MCP setup guide](mcp-setup.md) for connecting wu to AI tools
- Check `wu-daemon.service` in the project root for systemd service setup
