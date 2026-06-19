# Security Policy

DevMate is a local development gateway. It can read, edit, run commands, and use Git in the active workspace, so treat its MCP URL as sensitive.

## Default Protections

- The gateway listens on `127.0.0.1` only.
- Public MCP access requires a generated token by default.
- The copied MCP URL includes the token; do not post it publicly.
- `/control/health` is local-only.
- Public `/health` omits instance, path, and storage details unless explicitly enabled.
- `devMate.permissionProfile` defaults to `fullAccess` for single-user local development. Switch to `balanced` when you want obvious destructive shell/Git operations blocked.
- Hidden, secret, binary, log, database, and private-key paths are blocked by file tools.
- Recursive workspace scans and directory mutation preflight reject directories whose real path leaves the workspace.
- Reference workspaces are readonly.
- Directory delete/move is blocked unless `devMate.allowDirectoryMutations` is enabled.
- Git push can be blocked with `devMate.confirmBeforePush`.
- Audit entries redact common token, password, authorization, and API key patterns before they are written or returned.

## Reporting Issues

For a private project, fix security issues locally before sharing the VSIX or MCP URL.

For a public repository, report vulnerabilities through the repository security advisory flow if available, or open a minimal issue that avoids posting secrets, tokens, tunnel URLs, or private file paths.
