# Testing checklist

Automated checks:

```powershell
npm install
npm run check
npm run test:unit
npm run smoke:gateway
npm run package:vsix
```

Manual acceptance:

1. Install VSIX in VS Code.
2. Open a Git project.
3. Run `DevMate: Start`.
4. Confirm the copied URL includes `/mcp?token=`.
5. Add it as a ChatGPT App/Connector.
6. Run `project_snapshot`.
7. Modify a small test file.
8. Run `task_report`.
9. Run `git_save` on a temporary branch.
10. Confirm a request to `/mcp` without the token returns `401`.
11. Confirm directory delete/move is blocked unless `devMate.allowDirectoryMutations` is enabled.
12. Run `vscode_context` and confirm the active editor/diagnostics snapshot is present.
13. Run `detect_validation` and confirm it suggests the smallest relevant project checks.
14. Confirm `start_task` + a file create/edit + `rollback_task` restores the file state.
15. Switch `devMate.permissionProfile` to `balanced` and confirm `run_command` blocks `git reset --hard`.
16. Confirm invalid regex input to `search_text` returns a tool error.
17. Confirm `read_audit_log` redacts token-like values recorded by command audit entries.
18. Run `maintenance_status` and confirm backup/audit retention settings are present.
19. Run `connection_diagnostics` and confirm it reports gateway reachability, VS Code context freshness, diagnostics, and last public preflight.
20. Run `devmate_status_panel` in ChatGPT and confirm the Apps UI card renders without exposing the token URL.
21. In the DevMate panel, add a readonly reference with the folder picker, remove that single reference, and confirm the source folder is not deleted.
22. In the DevMate panel, paste a local folder path into the reference input and confirm it appears in `list_workspaces` as `readonly`.
23. Copy a folder path or GitHub repository URL, use `From Clipboard`, and confirm it is added as a readonly reference.
24. In a multi-root VS Code workspace, use `Open Folders` and confirm non-active folders become readonly references.
25. Edit the Advanced References JSON textarea, save it, and confirm invalid JSON or a missing folder shows an error instead of changing workspaces.
26. Optional network check: paste a public GitHub repository URL and confirm DevMate clones or updates it under VS Code global storage as a readonly reference.
27. Switch between two VS Code folders and reopen the DevMate panel; confirm Workspace state shows only the current active writable workspace and any explicit readonly references.
28. Use `Copy Context` and confirm the clipboard contains a redacted DevMate context bundle with project instructions, Git summary, scripts, file tree, VS Code context, and no MCP token.

Known external dependency: ngrok must be installed and authenticated.
