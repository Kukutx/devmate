# Contributing

This project is optimized for one-person local development first.

Principles:

- Single VS Code extension runtime.
- No separate gateway ZIP for daily use.
- Keep the default UX: open project, run DevMate: Start, paste URL into ChatGPT.
- Add advanced behavior as MCP tools or settings, not as daily manual steps.
- Do not store backups, audit logs, or config inside the user's project workspace.

Build from exported source:

```powershell
npm install
npm run check
npm run smoke:gateway
npm run package:vsix
```
