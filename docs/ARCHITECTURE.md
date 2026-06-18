# Architecture

DevMate contains two runtime parts inside one VS Code extension:

- `extension.js`: VS Code UX, status bar, config, ngrok process, public preflight.
- `gateway/server.mjs`: MCP server powered by the official MCP TypeScript SDK.

State is stored under VS Code global storage:

- `config.json`
- `state/backups/`
- `state/audit.jsonl`

The current VS Code folder is the default writable workspace. Reference projects are added as readonly workspaces.

VS Code editor context is captured by `extension.js` into `config.json` as a lightweight snapshot. The gateway reads that snapshot through MCP tools; it does not call VS Code APIs directly.

Security model:

- The HTTP server listens on `127.0.0.1` only.
- Public `/mcp` access goes through ngrok and requires the generated DevMate token by default.
- `/control/health` is local-only; public `/health` is minimal unless explicitly configured.
- File tools block hidden, secret, binary, log, database, and private key paths by default.
- Directory delete/move requires `devMate.allowDirectoryMutations` and refuses protected descendants.
- `fullAccess` is the default for single-user local development; `balanced` blocks obvious destructive commands and Git operations; `readOnly` blocks mutation tools.
- Task sessions add task IDs to audit entries and can roll back file changes using backups.
