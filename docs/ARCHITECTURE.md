# Architecture

DevMate contains two runtime parts inside one VS Code extension:

- `extension.js`: VS Code UX, status bar, config, ngrok process, public preflight.
- `gateway/server.mjs`: MCP server powered by the official MCP TypeScript SDK.

State is stored under VS Code global storage:

- `config.json`
- `state/backups/`
- `state/audit.jsonl`
- `references/github/`

The current VS Code folder is the default writable workspace. Reference projects are added as readonly workspaces. GitHub reference URLs are cloned or fast-forward updated under `references/github/`; removing a reference from DevMate only removes it from `config.json` and does not delete local source folders.

VS Code editor context is captured by `extension.js` into `config.json` as a lightweight snapshot. The gateway reads that snapshot through MCP tools; it does not call VS Code APIs directly.

Successful and failed public MCP preflight checks are recorded as a redacted connection snapshot in `config.json`. The snapshot stores host, tool count, timestamps, and errors, but not the full token URL.

`devmate_status_panel` uses an inline MCP Apps HTML resource (`ui://devmate/status.html`) to render connection diagnostics inside ChatGPT. The panel has no external assets and uses MCP tool calls for refresh when the host supports widget tool access.

Security model:

- The HTTP server listens on `127.0.0.1` only.
- Public `/mcp` access goes through ngrok and requires the generated DevMate token by default.
- `/control/health` is local-only; public `/health` is minimal unless explicitly configured.
- File tools block hidden, secret, binary, log, database, and private key paths by default.
- Directory delete/move requires `devMate.allowDirectoryMutations`, refuses protected descendants, and rejects recursive paths whose real path leaves the workspace.
- Audit logs are stored locally and redact common token, password, authorization, and API key patterns.
- The gateway prunes old backups and audit entries on startup using the configured retention days and size caps.
- ChatGPT Apps UI resources are diagnostic-only and do not expose the full MCP token URL.
- `fullAccess` is the default for single-user local development; `balanced` blocks obvious destructive commands and Git operations; `readOnly` blocks mutation tools.
- Task sessions add task IDs to audit entries and can roll back file changes using backups.
