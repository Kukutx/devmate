# Troubleshooting

## ChatGPT Connector Creation Fails

Use the URL copied by `DevMate: Start` or `DevMate: Copy URL`. The URL must look like:

```text
https://example.ngrok-free.dev/mcp?token=<real-token>
```

Do not copy a URL from DevMate logs, the panel label, or a screenshot when it shows `token=redacted`. Redacted URLs are intentionally not usable.

In ChatGPT's connector form:

- Connection type: server URL.
- Authentication: no authentication.
- URL path: keep `/mcp`.
- Query string: keep `?token=<real-token>`.
- Risk acknowledgement: enabled, because local MCP tools can edit files and run commands.

If ChatGPT reports a generic creation error:

1. Click `DevMate: Copy URL` again and paste the fresh clipboard value.
2. Make sure the pasted URL still includes `/mcp?token=`.
3. If ngrok restarted, delete the old connector and create a new one with the new URL.
4. Run `DevMate: Doctor` and confirm `Public MCP preflight OK`.
5. Keep authentication set to no authentication because DevMate already authenticates with the URL token.

## 401 Unauthorized

The connector URL is missing the token, contains `token=redacted`, or was copied from an old DevMate install/config. Use `DevMate: Copy URL` and paste the fresh clipboard value.

## 404 or Connection Error

The tunnel URL is stale, ngrok is not ready, or the `/mcp` path was removed. Run `DevMate: Start` again and use the newly verified URL.

## Model Switch Looks Disconnected

Switching models or reasoning modes can leave the current chat without the connector selected, or can force ChatGPT to rediscover tools. This is separate from the local gateway being down.

1. Ask ChatGPT to run `devmate_status_panel`.
2. If the panel renders, ChatGPT can still reach DevMate; check the panel advice and continue.
3. If no tools are available, add the DevMate connector again from the `+` menu in the chat.
4. If tools are available but the panel reports stale preflight, run `DevMate: Copy URL` or `DevMate: Start` in VS Code.
5. If the ngrok host changed, recreate or update the ChatGPT connector with the newly copied full token URL.

## Wrong Workspace

DevMate uses the active VS Code folder as the writable workspace by default. Open the intended folder in VS Code, then run `DevMate: Start` again. Use `list_workspaces` or `gateway_status` from ChatGPT to verify the active workspace.

## Reference Project Management

Use the DevMate panel to add readonly reference folders, paste a GitHub repository URL, remove a single reference, clear all references, or edit the References JSON directly. Removing a reference only updates DevMate configuration; it does not delete the original folder or the cached GitHub clone.

GitHub references require `git` on PATH and network access. If a GitHub reference fails, open `DevMate: Logs` and check the clone or pull error.

## Model Ignores Project Rules

Put project rules in root `AGENTS.md` or `CLAUDE.md`. DevMate exposes them through `project_instructions` and includes them in `project_snapshot`.

## Review Before Finishing

Use `show_changes` for a compact Git status, diff stat, file totals, and bounded patch. Use `task_report` when you also need recent DevMate audit entries.
