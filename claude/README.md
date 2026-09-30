# Claude Code configuration

Run `./setup ai` from the repository root. See the [setup guide](../README.md) for prerequisites and backup behavior.

## Managed resources

- A copy of the shared [AGENTS.md](../AGENTS.md) at `~/.claude/CLAUDE.md`.
- User-scoped Ponytail and Compound Engineering plugins.
- Official gh and gh-stack, agent-browser, grilling, and grill-me skills. These replace the duplicate kit gh-cli integration after confirmation.
- `hooks/readonly-gh-api.ts`, registered for Bash PreToolUse events.
- ccstatusline with model, token, usage, and context indicators.
- Official CodeGraph MCP in `~/.claude.json`, without automatic tool approval.

Setup disables automatic commit/PR attribution, session links, and Remote Control at startup. It preserves unrelated JSON settings and hooks. It does not import model choices, experimental flags, memory settings, or permission consent from another machine.

Claude's built-in terminal notifications replace the custom notify hook. Setup removes known legacy notify commands when you approve the settings merge. Check Claude, Ghostty, and macOS notification permissions yourself.

## Verify

Restart Claude Code, sign in, and check `/plugin` and `/mcp`.

These commands pass synthetic inputs to the gh api guard without making GitHub requests:

```sh
printf '%s\n' '{"tool_name":"Bash","tool_input":{"command":"gh api -X POST /repos/o/r/issues"}}' | bun ~/.claude/hooks/readonly-gh-api.ts
printf '%s\n' '{"tool_name":"Bash","tool_input":{"command":"gh api /repos/o/r/issues"}}' | bun ~/.claude/hooks/readonly-gh-api.ts
```

The first command should print a deny decision; the second should print nothing. This hook does not block every possible GitHub mutation, so the shared approval policy still applies.
