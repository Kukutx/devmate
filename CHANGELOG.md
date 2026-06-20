# Changelog

## 1.14.0

- Stopped historical writable workspaces from accumulating when switching VS Code projects.
- Migrated the workspace model to keep one active writable workspace plus explicit readonly references.
- Replaced raw Workspace JSON in the panel with a smaller workspace state summary.

## 1.13.0

- Updated repository metadata to the canonical `Kukutx/DevMate` GitHub path.
- Switched the gateway launch contract to `DEVMATE_CONFIG`, with `AIWG_CONFIG` retained as a compatibility fallback.
- Removed hidden legacy command aliases from older local builds to keep the command surface smaller.
- Prevented selected text from editors outside the active workspace from being captured in the VS Code context snapshot.
- Tightened public MCP preflight so copied URLs must initialize against the DevMate server.

## 1.12.0

- Added `Copy Context` for ChatGPT model surfaces that cannot call MCP tools.
- Included project instructions, Git status, diff stat, package scripts, a bounded file tree, VS Code context, and reference summaries in the copied bundle.
- Kept context bundle output token-free and blocked from hidden, secret, binary, and heavy generated paths.

## 1.11.0

- Simplified the DevMate reference workflow with a clearer panel layout.
- Added one-click reference import from clipboard.
- Added one-click import for extra VS Code workspace folders as readonly references.
- Moved raw JSON editing and clear-all into an advanced section.

## 1.10.0

- Added panel controls for adding references from a local path or GitHub repository URL.
- Added per-reference remove, clear-all, and editable References JSON management.
- Stored GitHub reference clones under VS Code global storage and kept them readonly for MCP tools.
- Normalized workspace roles so only the current VS Code folder is marked active.

## 1.9.0

- Added `connection_diagnostics` for checking ChatGPT-to-DevMate reachability, VS Code context freshness, workspace state, diagnostics, permissions, and recent public MCP preflight snapshots.
- Added `devmate_status_panel`, a lightweight ChatGPT Apps UI panel backed by an inline MCP resource.
- Persisted a redacted VS Code-side connection snapshot after successful or failed public MCP preflight checks.
- Added smoke coverage for MCP Apps resource registration and status UI rendering.

## 1.8.0

- Added automatic backup and audit log retention for long-running local development use.
- Added `maintenance_status` to report local backup/audit storage size and retention settings.
- Added unit coverage for maintenance pruning and wired it into CI.
- Added CI dependency audit and VSIX artifact upload.
- Redacted recent audit entries returned by `task_report`.

## 1.7.1

- Hardened MCP request URL parsing so malformed Host headers cannot affect route parsing.
- Added realpath boundary checks to recursive workspace scans and directory mutation preflight.
- Added basic sensitive value redaction for audit entries and audit log reads.
- Improved regex search fallback validation and reduced source export noise.

## 1.7.0

- Added `project_instructions` and included root `AGENTS.md` / `CLAUDE.md` context in `project_snapshot`.
- Added `show_changes` for compact Git status, diff stats, file totals, and bounded patch review.
- Added project agent instructions and ChatGPT Connector troubleshooting docs.
- Added GitHub Actions CI for repeatable check, smoke, and VSIX package verification.

## 1.6.2

- Added the DevMate extension icon with a white background.

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
