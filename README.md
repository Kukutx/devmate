# DevMate

DevMate is a personal VS Code extension that exposes the current workspace to ChatGPT through an MCP gateway.

Daily flow:

1. Open a project in VS Code.
2. Run `DevMate: Start`.
3. Paste the copied `https://.../mcp?token=...` URL into ChatGPT as an App/Connector.
4. In ChatGPT: `使用 DevMate，完成这个开发任务。`

Core abilities:

- Read project instructions from `AGENTS.md` / `CLAUDE.md`.
- Read, search, write, create, delete, move, and patch files.
- Run project commands.
- Use Git: status, diff, add, commit, push, pull, branch, switch, log, blame, stash.
- Add readonly reference projects.
- Review current changes with bounded Git summaries.
- Keep automatic backups and audit logs in VS Code global storage, not in your project.
- Automatically prune old backups and audit logs so long-running local use stays bounded.

Safety defaults:

- Public MCP requests require a per-install token by default. The copied URL includes it.
- The gateway binds to `127.0.0.1`; ngrok is the only intended public entry point.
- Hidden, binary, log, database, key, and real `.env` files are blocked from normal file tools.
- `devMate.permissionProfile` defaults to `fullAccess` for single-user local development.
- Use `readOnly` for inspection-only sessions or `balanced` when you want destructive shell/Git guards.
- Directory delete/move operations are blocked unless `devMate.allowDirectoryMutations` is enabled.
- Set `devMate.confirmBeforePush` to block MCP push requests until you deliberately disable it.
- Backups and audit logs default to 30-day retention with size caps; tune `devMate.backupRetentionDays`, `devMate.auditRetentionDays`, `devMate.maxBackupBytes`, and `devMate.maxAuditBytes` if needed.

Runtime requirement: `ngrok` must be installed and authenticated so ChatGPT can reach your local MCP endpoint over HTTPS.

Development checks:

```powershell
npm install
npm run check
npm run test:unit
npm run smoke:gateway
npm run package:vsix
```

See `docs/MCP_TOOLS.md` for the MCP tool list, `docs/TROUBLESHOOTING.md` for ChatGPT Connector setup issues, and `SECURITY.md` for the local gateway security model.
