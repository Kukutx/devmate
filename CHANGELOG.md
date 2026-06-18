# Changelog

## 1.6.1

- Added MCP tool output schemas and read/write/destructive/open-world annotations for better ChatGPT App planning.
- Fixed source export to create a unique export folder instead of deleting an existing `devmate-source` folder.
- Stopped DevMate from deleting unrelated ngrok tunnels when starting a tunnel for the current workspace.
- Redacted MCP tokens in VS Code notifications while still copying the full URL to the clipboard.
- Preserved spaces and non-ASCII path segments in DevMate backup paths.
- Removed placeholder repository metadata from the VS Code extension manifest.

## 1.6.0

- Changed the default permission profile to `fullAccess` for single-user local development.
- Added task session tools: `start_task`, `finish_task`, `task_status`, and `rollback_task`.
- Added task IDs to audit entries for writes, commands, Git operations, and rollbacks.
- Added rollback smoke coverage for file creation and balanced-profile dangerous command guards.

## 1.5.0

- Added lightweight permission profiles: `readOnly`, `balanced`, and `fullAccess`.
- Added dangerous shell and Git operation guards for normal development.
- Added VS Code context tools for active editor, selection, visible editors, and diagnostics.
- Added validation detection and smart check execution tools.
- Added single-file backup restore support.

## 1.4.0

- Added required runtime dependencies and lockfile for reproducible installs.
- Added default token authentication for public MCP requests.
- Bound the gateway to `127.0.0.1` and kept public health minimal by default.
- Added symlink-aware workspace path containment checks.
- Blocked workspace-root and directory mutations by default.
- Wired `confirmBeforePush`, command timeout, max output, configured commands, and default start command behavior.
- Added a repeatable gateway smoke test.

## 1.3.0

- Open-source readiness: license, cleaner manifest metadata, source export structure.
- Simplified UX: `DevMate: Start`, compact panel, simple prompt, settings command.
- Added `project_snapshot`, `list_project_scripts`, `run_project_script`, `git_save`, and `task_report` MCP tools.
- Public `/health` endpoint is minimal by default; detailed health moved to local-only `/control/health`.
- Fixed reference workspace branch mutation guard.
- Added package script discovery and one-call task reporting.

## 1.2.0

- Renamed plugin to DevMate.
- Preserved single VS Code extension runtime and official MCP SDK gateway.
