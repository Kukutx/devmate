# Testing checklist

Automated checks:

```powershell
npm install
npm run check
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

Known external dependency: ngrok must be installed and authenticated.
