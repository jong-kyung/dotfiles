# Pi configuration

Run `./setup pi` from the repository root, or select `5` in the `./setup` menu. This stage does not install or configure Claude Code. See the [setup guide](../README.md) for prerequisites and backup behavior.

## Managed resources

- A copy of the shared [AGENTS.md](../AGENTS.md).
- Pi packages: pi-subagents, pi-ask-user, Ponytail, and Compound Engineering.
- Skills: official gh and gh-stack, agent-browser, grilling, and grill-me.
- Official CodeGraph MCP through Pi's built-in MCP support. Setup preserves existing custom CodeGraph resources.

Existing model, provider, thinking, and theme preferences remain unchanged. On a new installation, choose your model after signing in.

## Local extensions

| File | Purpose |
| --- | --- |
| `extensions/context.ts` | Inspect loaded resources and context usage |
| `extensions/files.ts` | Browse, open, attach, and inspect file changes |
| `extensions/loop.ts` | Repeat follow-up work when requested |
| `extensions/notify.ts` | Send terminal notifications for completion and input requests |
| `extensions/readonly-gh-api.ts` | Restrict mutating gh api requests and GraphQL |
| `extensions/session-breakdown.ts` | Summarize usage and costs across sessions |

Setup copies these files individually and preserves unrelated extensions. Herdr manages its own generated integration file.

Notifications depend on terminal support, macOS permissions, and Focus settings. The gh api guard checks command patterns; it is not a security sandbox.

## Verify

Start a new Pi session and use `/login`, then check:

```sh
pi list
pi mcp list
codegraph --version
```

Open `/context`, `/files`, and `/session-breakdown`. A new Mac has no session history to display. Run `codegraph init` yourself in projects you want to index.
