# DevMate Agent Instructions

## Environment

- Windows native + PowerShell.
- Use PowerShell-compatible commands.
- Do not use bash/Linux commands unless explicitly requested.

## Coding Style

- Make surgical, minimal changes.
- Do not refactor unrelated code.
- Match the existing project style.
- Prefer simple solutions over abstractions.
- Ask before adding new production dependencies.

## Verification

- After code changes, run the smallest relevant check first.
- For this VS Code extension, prefer:
  - `npm run check`
  - `npm run smoke:gateway`
  - `npm run package:vsix`

## Safety

- Never touch secrets, env files, or unrelated config unless requested.
- Keep public MCP URLs token-protected by default.
- Use `task_report` or `show_changes` before summarizing completed code changes.
