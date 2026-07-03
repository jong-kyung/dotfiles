# Pi setup

This directory manages the pi settings and project-local resources used by this repository.

## What this repo manages

This repo tracks the Pi extensions and project-owned skills used by the local global setup so they can be reviewed, copied, or symlinked into another Pi environment.

- `pi/skills/acli-jira/`
  - Adds the `acli-jira` skill for working with Jira Cloud from the command line using Atlassian's official `acli` tool.
- `pi/extensions/btw.ts`
  - Adds `/btw`, a side-channel assistant popover for quick questions without disrupting the main thread.
- `pi/extensions/context.ts`
  - Adds `/context`, a TUI overview of loaded extensions, skills, context files, token usage, and session cost.
- `pi/extensions/codegraph.ts`
  - Adds the `codegraph` tool for semantic codebase search, context building, call graphs, impact analysis, and affected-test discovery. Automatically runs `codegraph sync --quiet` before read/query-style actions so the CLI-backed index stays fresh. Requires the CodeGraph CLI on `PATH`.
- `pi/extensions/control.ts`
  - Adds session-control flags, `/control-sessions`, and optional `send_to_session` / `list_sessions` tools when Pi is launched with `--session-control`.
- `pi/extensions/files.ts`
  - Adds `/files` plus file-navigation shortcuts for browsing git/session files, opening/revealing files, adding file mentions, and viewing diffs.
- `pi/extensions/loop.ts`
  - Adds `/loop` and the `signal_loop_success` tool for follow-up loops that run until a breakout condition is met.
- `pi/extensions/notify.ts`
  - Sends terminal-native notifications when Pi finishes work, waits for `ask_user` input, or receives a subagent async-completion event.
- `pi/extensions/session-breakdown.ts`
  - Adds `/session-breakdown`, an interactive usage dashboard for recent Pi sessions by model, cwd, day, time, tokens, and cost.
- `pi/extensions/skill-manager/`
  - Adds `/skill-status`, `/skill-update`, and `/skill-remove` for safe skill/package lifecycle management.

Install or refresh these extensions globally with:

```bash
mkdir -p ~/.pi/agent/extensions
rsync -a --delete --delete-excluded --exclude '__tests__/' pi/extensions/ ~/.pi/agent/extensions/
```

Verify the global copy is in sync; no output means there is no drift:

```bash
rsync -ain --delete --delete-excluded --exclude '__tests__/' pi/extensions/ ~/.pi/agent/extensions/
```

Install or refresh tracked local skills globally with:

```bash
mkdir -p ~/.pi/agent/skills
rsync -a --delete pi/skills/acli-jira/ ~/.pi/agent/skills/acli-jira/
```

Verify the tracked skill is in sync; no output means there is no drift:

```bash
rsync -ain --delete pi/skills/acli-jira/ ~/.pi/agent/skills/acli-jira/
```

Restart pi after extension or skill changes so loaded commands, tools, and skills refresh.

For project-local usage, copy or symlink individual files into `.pi/extensions/` or `.pi/skills/` instead.

## Terminal-native notifications

`pi/extensions/notify.ts` emits one selected native terminal notification path per event. It does not broadcast multiple protocols, and it intentionally no-ops for unsupported or ambiguous terminal signals to avoid raw escape output.

| Terminal family | Representative signal | Native path | Status |
| --- | --- | --- | --- |
| Warp | `TERM_PROGRAM=WarpTerminal` | OSC 777 | Preserves existing Warp behavior |
| Ghostty | `TERM=xterm-ghostty`, `TERM_PROGRAM=ghostty`, or `GHOSTTY_*` env | OSC 9 | Implemented from Ghostty's documented desktop-notification protocol; live visual validation still depends on Ghostty notification settings and OS focus/DND policy |
| WezTerm | `WEZTERM_*` env or `TERM_PROGRAM=WezTerm` | OSC 777 | Supported when WezTerm notification handling is enabled |
| iTerm2 | `TERM_PROGRAM=iTerm.app` | OSC 9 | Supported through iTerm2's native notification escape |
| Kitty | `KITTY_WINDOW_ID` or Kitty terminfo | OSC 99 | Separate Kitty-family path |
| rxvt/urxvt | rxvt/urxvt terminfo | OSC 777 | Best-effort protocol-family support; narrow or remove this claim if representative validation fails |

Limitations:

- There is no OS-level notifier fallback and no user-configurable notifier command in this version.
- tmux, screen, ssh, remote shells, and terminal gateways are not guaranteed. A strong terminal-specific signal can still select its native path inside a multiplexer, but passthrough settings may prevent delivery.
- Terminal and OS notification permissions, focus rules, and Do Not Disturb settings can still suppress visible notifications.
- If multiple terminal-specific signals conflict, Pi treats the session as unsupported and writes nothing.


## Required pi packages

These packages are currently used by the global pi setup.

```bash
pi install npm:pi-subagents
pi install npm:pi-ask-user
pi install npm:pi-mcp-adapter
pi install git:github.com/DietrichGebert/ponytail
```

Ponytail adds always-on minimal-code guidance plus `/ponytail`, `/ponytail-review`, `/ponytail-audit`, `/ponytail-debt`, `/ponytail-gain`, and `/ponytail-help`. Set the default mode with `PONYTAIL_DEFAULT_MODE=lite|full|ultra|off` or `~/.config/ponytail/config.json`.

Verify:

```bash
pi list
```

Update:

```bash
pi update --extensions
```

## Required CLIs

The `codegraph` extension shells out to the CodeGraph CLI. Install it separately before enabling the extension on a new machine, then verify it is on `PATH`:

```bash
codegraph --version
```

The current local machine uses CodeGraph CLI `0.9.4` at `~/.local/bin/codegraph`.

## MCP adapter

`pi-mcp-adapter` lets pi use MCP servers without loading every MCP tool definition into the context window. It is installed by the required package setup above.

Restart pi after installation. The adapter reads standard MCP config files such as `.mcp.json` and `~/.config/mcp/mcp.json`; run `/mcp setup` inside pi to inspect or import host-specific MCP configs.

The current local `~/.pi/agent/mcp.json` includes the Figma desktop MCP server and disables MCP tool prefixes:

```json
{
  "settings": {
    "toolPrefix": "none"
  },
  "mcpServers": {
    "figma": {
      "url": "http://127.0.0.1:3845/sse",
      "directTools": true
    }
  }
}
```

## Skill manager

This repo includes a project-local Pi extension for inspecting and safely managing Pi skill/package lifecycle targets.

Use these read-only commands when the local skill inventory below needs refreshing:

```bash
pi list
npx skills list -g --agent pi
find ~/.pi/agent/skills ~/.agents/skills -maxdepth 2 -name SKILL.md | sort
```

Use `/skill-status <target>` to inspect ownership before updating a specific skill, and `/skill-update <target>` only for targets reported as safely updateable.

Commands:

```text
/skill-status <target>   # inspect owner/source/resources/freshness/actions without mutation commands
/skill-update <target>   # show an update plan, then apply only supported targets after confirmation
/skill-remove <target> [--global]  # show a removal plan, then apply only supported targets after confirmation
```

Support matrix:

| Target                                     | Status                               | Update                                                                 | Remove                                                           |
| ------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Discovered plugin bundle                   | Supported from `install-manifest.json` | Guidance-only; update manually unless updater metadata exists          | Guidance-only                                                    |
| Plugin bundle member                       | Supported as bundle-owned            | Guidance-only via owning bundle; update manually                       | Guidance-only                                                    |
| Exact-one unpinned npm/git Pi package      | Supported                            | Supported after plan and high-risk confirmation                        | Supported after confirmation                                     |
| Pinned or local exact-one Pi package        | Supported as discovered        | Guidance-only                                                          | Supported after confirmation                                     |
| Duplicate or ambiguous Pi package           | Supported as discovered        | Guidance-only                                                          | Guidance-only until target ownership is exact                    |
| Safe local `npx skills` skill              | Supported from local lock/path metadata | Supported via exact `skills@1.5.7` CLI after confirmation             | Pi-visibility-only by default; `--global` remains guidance-only   |
| Unverified `npx skills` skill              | Supported as discovered              | Guidance-only                                                          | Guidance-only                                                    |

Safety defaults:

- Status and completions do not run `npx`, `bunx`, `pi update`, or `pi remove`.
- `/skill-status` may perform a bounded GitHub release/tag freshness check for exactly resolved GitHub targets with a comparable local semver; failures and missing version evidence render as `Unknown` or `Check unavailable`.
- Mutating commands require confirmation and use the same status resolver before applying anything.
- Homebrew CLIs and unmanaged resources are not removed. Safe local `npx skills` targets default to Pi-visibility-only removal; whole-global removal remains guidance-only and should be done manually when intended.
- Resource-changing commands write a short receipt and reload Pi so the current session reflects updated skills.

## Compound Engineering

Install the Compound Engineering skills and subagents bundle with `compound-plugin`.

```bash
bunx @every-env/compound-plugin install compound-engineering --to pi
```

After installation, resources are created in these locations:

- Skills: `~/.pi/agent/skills/ce-*`, `~/.pi/agent/skills/lfg`
- Agents: `~/.pi/agent/agents/ce-*.md`
- Manifest: `~/.pi/agent/compound-engineering/install-manifest.json`

Compound Engineering uses the pi subagents and ask-user tools, so `pi-subagents` and `pi-ask-user` must also be installed.

## Additional Pi-local skills

The current local `~/.pi/agent/skills/` includes:

- Compound Engineering bundle skills (`ce-*`, `lfg`) from `~/.pi/agent/compound-engineering/install-manifest.json`.
- Figma workflow skills installed from `figma/mcp-server-guide` (see below).
- Tracked project-owned skills from this repo: `acli-jira` from `pi/skills/acli-jira/`.
- Loose local skills with no package-manager lock metadata: `skill-review`. Preserve it by copying its folder from an existing machine, or omit it on machines that do not need it.

Installed Pi packages also provide runtime skills: `ask-user` from `pi-ask-user`, `pi-subagents` from `pi-subagents`, and `ponytail*` skills from Ponytail.

## Figma MCP skills

Install or refresh the local Figma workflow skills from Figma's official MCP guide repository:

```bash
tmp=$(mktemp -d)
git clone --depth 1 https://github.com/figma/mcp-server-guide "$tmp"
mkdir -p ~/.pi/agent/skills

for path in \
  skills/figma-code-connect \
  skills/figma-create-new-file \
  skills/figma-generate-design \
  skills/figma-generate-diagram \
  skills/figma-generate-library \
  skills/figma-use \
  skills/figma-use-figjam \
  workflow-skills/generate-project-plan
do
  rsync -a --delete "$tmp/$path/" "$HOME/.pi/agent/skills/${path##*/}/"
done

make_figma_skill() {
  name="$1" source="$2" description="$3" target="$HOME/.pi/agent/skills/$name"
  mkdir -p "$target"
  printf -- '---\nname: %s\ndescription: %s\ndisable-model-invocation: false\n---\n' "$name" "$description" > "$target/SKILL.md"
  cat "$tmp/figma-power/steering/$source.md" >> "$target/SKILL.md"
}

make_figma_skill figma-implement-design implement-design \
  "Translates Figma designs into production-ready application code with 1:1 visual fidelity."
make_figma_skill figma-create-design-system-rules create-design-system-rules \
  "Generates custom design system rules for Figma-to-code workflows."

rm -rf "$tmp"
```

`figma-implement-design` and `figma-create-design-system-rules` are Pi wrappers around `figma-power/steering/*.md`. Restart Pi after installing or refreshing these skills.

## Agent Browser

Install both the browser automation CLI and the pi skill.

```bash
brew install agent-browser
npx skills add https://github.com/vercel-labs/agent-browser --skill agent-browser --agent pi -g -y
```

Verify:

```bash
agent-browser --version
agent-browser skills get core --full
```

Update:

```bash
brew upgrade agent-browser
npx skills update agent-browser -g -y
```

## Additional global skills in use

On this machine, pi also auto-loads skills from `~/.agents/skills/`. Run these commands to reproduce the same setup.

```bash
# Skill discovery helper
npx skills add https://github.com/vercel-labs/skills --skill find-skills --agent pi -g -y

# Browser automation is documented in the Agent Browser section above.

# GitHub and Atlassian workflow skills
npx skills add https://github.com/hamsurang/kit --skill gh-cli --agent pi -g -y
npx skills add https://github.com/jeffallan/claude-skills --skill atlassian-mcp --agent pi -g -y

# React / UI engineering skills
npx skills add https://github.com/vercel-labs/agent-skills \
  --skill vercel-react-best-practices vercel-composition-patterns web-design-guidelines \
  --agent pi -g -y

# Current browser platform guidance for frontend work
npx skills add https://github.com/GoogleChrome/modern-web-guidance --skill modern-web-guidance --agent pi -g -y

# Planning/doc review helpers
npx skills add https://github.com/mattpocock/skills --skill grill-me grill-with-docs --agent pi -g -y

# React quality checker
npx skills add https://github.com/millionco/react-doctor --skill react-doctor --agent pi -g -y
```

Verify:

```bash
npx skills list -g --agent pi
```

Update:

```bash
npx skills update -g -y
```

## Quick setup for a new machine

```bash
# 1. pi package dependencies
pi install npm:pi-subagents
pi install npm:pi-ask-user
pi install npm:pi-mcp-adapter
pi install git:github.com/DietrichGebert/ponytail

# 1b. Required CLIs for tracked extensions
codegraph --version  # install CodeGraph CLI first if this fails

# 2. Global extensions and project-owned skills tracked by this repo
mkdir -p ~/.pi/agent/extensions ~/.pi/agent/skills
rsync -a --delete --delete-excluded --exclude '__tests__/' pi/extensions/ ~/.pi/agent/extensions/
rsync -a --delete pi/skills/acli-jira/ ~/.pi/agent/skills/acli-jira/

# 3. Compound Engineering
bunx @every-env/compound-plugin install compound-engineering --to pi

# 4. Figma MCP skills
# Run the install/refresh snippet in the "Figma MCP skills" section above.

# 5. Browser automation
brew install agent-browser
npx skills add https://github.com/vercel-labs/agent-browser --skill agent-browser --agent pi -g -y

# 6. Other global skills
npx skills add https://github.com/vercel-labs/skills --skill find-skills --agent pi -g -y
npx skills add https://github.com/hamsurang/kit --skill gh-cli --agent pi -g -y
npx skills add https://github.com/jeffallan/claude-skills --skill atlassian-mcp --agent pi -g -y
npx skills add https://github.com/vercel-labs/agent-skills \
  --skill vercel-react-best-practices vercel-composition-patterns web-design-guidelines \
  --agent pi -g -y
npx skills add https://github.com/GoogleChrome/modern-web-guidance --skill modern-web-guidance --agent pi -g -y
npx skills add https://github.com/mattpocock/skills --skill grill-me grill-with-docs --agent pi -g -y
npx skills add https://github.com/millionco/react-doctor --skill react-doctor --agent pi -g -y
```

## Security notes

pi extensions and skills can run with local permissions or instruct the model to execute commands. Review third-party packages and skills before installing them, and enable automatic updates only for resources you trust.

Lifecycle commands are intentionally plan-first: status/completion is read-only, and update/remove actions run only after explicit confirmation.

## Prompts to paste into a Pi agent

Use one of these prompts when setting up a new machine or a fresh checkout.

```text
Read this repo's pi/README.md and check which pi setup steps are needed on this machine.
Before running any install or sync commands, summarize the missing or drifted required packages, global extensions, skills, and CLIs, then ask for confirmation.
Do not modify items that are already installed or already in sync.
```

For a full setup handoff:

```text
Configure the pi environment using the quick setup section in pi/README.md.
Check whether each item is already installed or in sync first, and install or sync only the missing/drifted items.
After setup, verify with pi list, codegraph --version, rsync -ain --delete --delete-excluded --exclude '__tests__/' pi/extensions/ ~/.pi/agent/extensions/, find ~/.pi/agent/skills -maxdepth 2 -name SKILL.md | grep figma, npx skills list -g --agent pi, and agent-browser --version.
```

For updates only:

```text
Use pi/README.md to update the currently installed pi packages, global extensions, Figma MCP skills, global skills, and agent-browser.
Summarize versions before and after the update, plus extension sync status. Do not modify pinned packages or items that require manual review; report them instead.
```
