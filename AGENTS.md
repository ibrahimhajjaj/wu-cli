# AGENTS.md

Orientation for anyone (human or assistant) working in this repo.

## What this is

WhatsApp CLI ("wu"), built on `@whiskeysockets/baileys`. A daemon collects
messages into SQLite; the CLI and an MCP server read/act through it.

## Commands

- Build: `npm run build` (`tsc && chmod +x dist/cli/index.js`)
- Dev (run from source): `npm run dev -- <args>` (`tsx src/cli/index.ts`)
- Test: `npm test` (`tsx --test tests/*.test.ts`, uses `node:test`)
- Typecheck: no dedicated script yet; use `npx tsc --noEmit`

## Architecture

- **Daemon**: `wu daemon` (persistent) or `wu listen` (foreground) holds the
  only live WhatsApp socket and ingests messages into SQLite + FTS5. Both
  commands take the same lock file (`src/core/lock.ts`), so only one can run
  at a time. Source: `src/core/listener.ts`, `src/core/store.ts`,
  `src/db/schema.ts` (`messages_fts` virtual table), `src/db/database.ts`.
- **IPC**: CLI and MCP reach a running daemon over a Unix domain socket
  (`src/core/ipc.ts`, newline-delimited JSON) to reuse the single login.
  Never open a second WhatsApp login while the daemon runs - Baileys treats
  a second socket as a competing session and can drop both.
- **MCP**: stdio-only server (`src/mcp/server.ts` uses
  `StdioServerTransport`; no HTTP transport exists). Tools are registered in
  `src/mcp/tools.ts` - 35 tools as of this writing (`grep -c 'server.tool('
  src/mcp/tools.ts`).
- **Run-mode ladder** for write/media tools: in-process socket (`getSock()`)
  → daemon IPC (`daemonIpcAvailable`/`daemonRequest`) → remote SSH
  (`sshWuExec`). See the per-tool fallbacks in `src/mcp/tools.ts` and
  `src/core/remote.ts`.
- **Remote**: sync of DB and media from a VPS over SSH - `sqlite3-rsync` when
  available, `rsync` (backup+rsync) fallback for the DB, plain `rsync` for
  media. Source: `src/core/remote.ts`.

## Invariants (do not violate)

- Baileys is pinned EXACT (`7.0.0-rc13`) on purpose - deterministic deploys
  of a reverse-engineered library (commit `31ea821`). Do not widen the
  range; bump only deliberately and test against a real session.
- Opt-in constraint model: the default constraint mode is `none`, meaning
  nothing is collected until a chat is explicitly set to `full` or `read`
  (`src/core/constraints.ts`, `ConstraintMode` in `src/config/schema.ts`).
  Respect the resolved mode (`full`/`read`/`none`) in any new read/write
  path - `shouldCollect` gates ingestion, `assertCanSend`/`assertCanManage`
  gate writes.
- MCP is stdio-only. Do not add an HTTP transport without a reason.
- Message content off the wire is untrusted data (a prompt-injection surface
  for MCP consumers reading chat history). Do not let it drive tool calls
  implicitly.
- `~/.wu` (`WU_HOME`) holds auth credentials, the message DB, and media -
  all sensitive. `ensureWuHome` (`src/config/paths.ts`) creates it and the
  auth dir `0700`, and the daemon IPC socket is created `0600`. Keep any new
  sensitive path you add under `WU_HOME` owner-only too.

## Testing

- `npm test` is the current gate (`tests/*.test.ts`, `node:test` via `tsx`).
  Add characterization tests before refactoring the daemon runtime
  (connection/listener/media/sender).

## Where things live

- `src/cli/` - Commander commands, one file per group
- `src/core/` - daemon logic, store, ipc, remote, media, enrich, export,
  constraints
- `src/mcp/` - stdio MCP server, tools, resources
- `src/db/` - schema (incl. FTS5), migrations, database handle
- `src/config/` - zod config schema, paths, logger
- `src/lib.ts` - library export surface for the above

## Further reading

- `README.md` - user-facing command reference and install steps
- `docs/getting-started.md`, `docs/mcp-setup.md` - setup guides
