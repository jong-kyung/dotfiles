# Claude Code setup

This directory manages the Claude Code global configuration used by this repository. It is designed for a one-time bootstrap on a new machine: an agent (or a human) reads this README and applies each section. There is no plugin/marketplace packaging for the repo-owned resources; external resources are installed from their own marketplaces or repositories so they update on their own.

## What this repo manages

- `claude/CLAUDE.md`
  - Global behavioral guidelines for `~/.claude/CLAUDE.md`. This file fully owns the global CLAUDE.md — install by overwrite, not merge.
- `claude/skills/`
  - Symlinks into `../pi/skills/` (`acli-jira`, `codegraph`). `pi/skills/` is the single source of truth for skills shared between pi and Claude Code. Install with `rsync -L` so the symlinks are materialized as real directories.
- `claude/hooks/notify.ts`
  - Terminal-native notifications on `Stop`, `Notification`, and `SubagentStop`. A standalone bun script (no pi dependency) with its own terminal detection (ghostty/iTerm2 → OSC 9, kitty → OSC 99, Warp/WezTerm → OSC 777). Writes to `/dev/tty` because Claude Code captures hook stdout; stays silent when the terminal is unsupported, signals conflict, or no tty is available.
- `claude/hooks/readonly-gh-api.ts`
  - `PreToolUse` guard restricting `gh api` to readonly usage (port of `pi/extensions/readonly-gh-api.ts`). Denies Bash `gh api` calls that mutate: write methods (`-X`/`--method POST|PATCH|PUT|DELETE`), field flags (`-f`/`-F`/`--field`/`--raw-field`/`--input`, which make `gh api` default to POST), or `gh api graphql`.
- `claude/settings.hooks.json`
  - The complete `hooks` value for `~/.claude/settings.json`. It replaces the `hooks` key wholesale — nothing outside this fragment is expected to live there.
- `claude/ccstatusline/settings.json`
  - Configuration for the `ccstatusline` status line (`bunx -y ccstatusline@latest`).

## Required CLIs

```bash
codegraph --version   # CodeGraph CLI, used by the codegraph skill and policy
bun --version         # runs the hooks and ccstatusline
```

## Install repo-owned resources

Run from the repository root. `-L` materializes the repo symlinks into real directories/files.

```bash
# Global CLAUDE.md (full overwrite)
rsync -a claude/CLAUDE.md ~/.claude/CLAUDE.md

# Skills (per-skill, so unrelated skills in ~/.claude/skills are untouched)
mkdir -p ~/.claude/skills
rsync -aL --delete claude/skills/acli-jira/ ~/.claude/skills/acli-jira/
rsync -aL --delete claude/skills/codegraph/ ~/.claude/skills/codegraph/

# Hooks (this repo owns ~/.claude/hooks entirely)
mkdir -p ~/.claude/hooks
rsync -aL --delete claude/hooks/ ~/.claude/hooks/

# Status line configuration
mkdir -p ~/.config/ccstatusline
rsync -a claude/ccstatusline/settings.json ~/.config/ccstatusline/settings.json
```

Register the hooks and status line in `~/.claude/settings.json` (replaces the `hooks` key wholesale, keeps everything else):

```bash
bun -e '
const fs = require("fs");
const path = require("os").homedir() + "/.claude/settings.json";
const settings = JSON.parse(fs.readFileSync(path, "utf8"));
settings.hooks = JSON.parse(fs.readFileSync("claude/settings.hooks.json", "utf8")).hooks;
settings.statusLine = { type: "command", command: "bunx -y ccstatusline@latest", padding: 0 };
fs.writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
'
```

Verify the copies are in sync; no output means there is no drift. (Content-based `diff` is used on purpose: macOS ships openrsync, whose checksum mode misbehaves with symlinked sources, and mtime-based checks false-positive when Claude Code touches the installed files.)

```bash
diff -r claude/skills/acli-jira ~/.claude/skills/acli-jira
diff -r claude/skills/codegraph ~/.claude/skills/codegraph
diff -r claude/hooks ~/.claude/hooks
diff claude/CLAUDE.md ~/.claude/CLAUDE.md
diff claude/ccstatusline/settings.json ~/.config/ccstatusline/settings.json
```

Smoke-test the `gh api` guard:

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"gh api -X POST /repos/o/r/issues"}}' | bun ~/.claude/hooks/readonly-gh-api.ts   # prints a deny decision
echo '{"tool_name":"Bash","tool_input":{"command":"gh api /repos/o/r/issues"}}' | bun ~/.claude/hooks/readonly-gh-api.ts           # prints nothing
```

Restart Claude Code after installing so hooks, skills, and CLAUDE.md reload.

## Marketplaces and plugins

Register the external marketplaces and install the plugins used by this setup:

```text
/plugin marketplace add EveryInc/compound-engineering-plugin
/plugin marketplace add hamsurang/kit
/plugin marketplace add DietrichGebert/ponytail
/plugin install compound-engineering@compound-engineering-plugin
/plugin install gh-cli@kit
/plugin install ponytail@ponytail
```

Notes:

- `gh-cli` comes from the kit plugin, not from `npx skills` — do not also install it as a global skill for the claude agent.
- The `figma` plugin (official marketplace) may be enabled locally but is intentionally not managed by this repo.
- Ponytail adds always-on minimal-code guidance plus `/ponytail`, `/ponytail-review`, `/ponytail-audit`, `/ponytail-debt`, `/ponytail-gain`, and `/ponytail-help`. Default mode is `full`; override with `PONYTAIL_DEFAULT_MODE=lite|full|ultra|off` or `~/.config/ponytail/config.json` (neither is set on this machine — defaults are used).

## Additional global skills in use

Claude Code auto-loads skills from `~/.claude/skills/`, where these are installed as symlinks into the shared `~/.agents/skills/` directory. Run these to reproduce the same setup:

```bash
# Skill discovery helper
npx skills add https://github.com/vercel-labs/skills --skill find-skills --agent claude-code -g -y

# Browser automation (CLI + skill)
brew install agent-browser
npx skills add https://github.com/vercel-labs/agent-browser --skill agent-browser --agent claude-code -g -y

# React / UI engineering skills
npx skills add https://github.com/vercel-labs/agent-skills \
  --skill vercel-react-best-practices vercel-composition-patterns web-design-guidelines \
  --agent claude-code -g -y

# Current browser platform guidance for frontend work
npx skills add https://github.com/GoogleChrome/modern-web-guidance --skill modern-web-guidance --agent claude-code -g -y

# Planning/doc review helpers
npx skills add https://github.com/mattpocock/skills --skill grill-me grill-with-docs grilling domain-modeling --agent claude-code -g -y

# React quality checker
npx skills add https://github.com/millionco/react-doctor --skill react-doctor --agent claude-code -g -y

# Writing quality guard against AI slop
npx skills add https://github.com/hardikpandya/stop-slop --skill stop-slop --agent claude-code -g -y
```

Verify:

```bash
npx skills list -g --agent claude-code
```

## Prompts to paste into Claude Code

For a full setup on a new machine:

```text
Configure the Claude Code global environment using claude/README.md in this repo.
Check whether each item is already installed or in sync first, and install or sync only the missing/drifted items.
After setup, verify with the diff drift checks, the readonly-gh-api smoke test, /plugin list, and npx skills list -g --agent claude-code.
```

For a status check without changes:

```text
Read claude/README.md and report which Claude Code setup steps are missing or drifted on this machine.
Do not run any install or sync commands.
```
