# MCP Tools

DevMate exposes development tools over MCP after `DevMate: Start` verifies the public URL.

## Workspace Context

- `gateway_status`
- `gateway_self_test`
- `maintenance_status`
- `start_task`
- `finish_task`
- `task_status`
- `rollback_task`
- `list_workspaces`
- `vscode_context`
- `active_editor_context`
- `list_diagnostics`
- `workspace_map`
- `project_snapshot`
- `project_instructions`
- `list_files`
- `search_text`

`project_snapshot` includes root project instructions by default. `project_instructions` reads root `AGENTS.md` / `CLAUDE.md` and lists nested instruction files so ChatGPT can follow project-specific rules.
`maintenance_status` reports local backup/audit retention settings and current storage size.

## File Operations

- `read_file`
- `write_file`
- `create_file`
- `apply_patch`
- `delete_file`
- `move_file`
- `list_backups`
- `restore_backup`
- `read_audit_log`

File tools block hidden, secret, binary, log, database, private key, and real `.env` paths by default. Directory delete/move is disabled unless `devMate.allowDirectoryMutations` is enabled.

## Commands

- `list_project_scripts`
- `run_project_script`
- `list_configured_commands`
- `run_configured_command`
- `run_command`
- `detect_validation`
- `run_smart_checks`

`run_command` is intentionally powerful. It is limited to the selected writable workspace, uses the configured timeout/output caps, and writes audit entries.
The default `fullAccess` profile is intended for single-user local development. Use `balanced` when you want obvious destructive shell commands and dangerous Git operations blocked, or `readOnly` for inspection-only sessions.

Task sessions add a `taskId` to audit entries. `rollback_task` restores file changes from DevMate backups where safe; commands and Git history operations are reported but not automatically reversed.

## Git

- `git_status`
- `git_diff`
- `git_add`
- `git_stage`
- `git_staged_files`
- `git_commit`
- `git_save`
- `git_push`
- `git_pull`
- `git_branch`
- `git_checkout`
- `git_log`
- `git_blame`
- `git_stash`
- `git_raw`

Reference workspaces cannot mutate Git state. Set `devMate.confirmBeforePush` to block push operations through MCP until you deliberately disable it.

## Reporting

- `show_changes`
- `task_report`

Use `show_changes` for compact status, diff stats, file totals, and a bounded patch. Use `task_report` after edits when you also need staged changes and recent audit entries.
