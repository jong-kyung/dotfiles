# Pi setup

This directory manages the pi settings and project-local resources used by this repository.

## What this repo manages

- `.pi/extensions/warp-notify.ts`
  - Sends Warp terminal notifications when pi finishes work, waits for `ask_user` input, or receives a subagent async-completion event.
  - pi automatically discovers `.pi/extensions/*.ts` as project-local extensions.

> Note: If the same extension also exists in `~/.pi/agent/extensions/`, notifications may fire twice. Remove the global copy if you want to use only this repo-managed version.
>
> ```bash
> rm ~/.pi/agent/extensions/warp-notify.ts
> ```

## Required pi packages

These packages are currently used by the global pi setup.

```bash
pi install npm:pi-subagents
pi install npm:pi-ask-user
```

Verify:

```bash
pi list
```

Update:

```bash
pi update --extensions
```

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

# GitHub CLI workflow skill
npx skills add https://github.com/hamsurang/kit --skill gh-cli --agent pi -g -y

# React / UI engineering skills
npx skills add https://github.com/vercel-labs/agent-skills \
  --skill vercel-react-best-practices vercel-composition-patterns web-design-guidelines \
  --agent pi -g -y

# Planning/doc review helper
npx skills add https://github.com/mattpocock/skills --skill grill-with-docs --agent pi -g -y

# React quality checker
npx skills add https://github.com/aidenybai/react-doctor --skill react-doctor --agent pi -g -y
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

# 2. Compound Engineering
bunx @every-env/compound-plugin install compound-engineering --to pi

# 3. Browser automation
brew install agent-browser
npx skills add https://github.com/vercel-labs/agent-browser --skill agent-browser --agent pi -g -y

# 4. Other global skills
npx skills add https://github.com/vercel-labs/skills --skill find-skills --agent pi -g -y
npx skills add https://github.com/hamsurang/kit --skill gh-cli --agent pi -g -y
npx skills add https://github.com/vercel-labs/agent-skills \
  --skill vercel-react-best-practices vercel-composition-patterns web-design-guidelines \
  --agent pi -g -y
npx skills add https://github.com/mattpocock/skills --skill grill-with-docs --agent pi -g -y
npx skills add https://github.com/aidenybai/react-doctor --skill react-doctor --agent pi -g -y
```

## Security notes

pi extensions and skills can run with local permissions or instruct the model to execute commands. Review third-party packages and skills before installing them, and enable automatic updates only for resources you trust.

## Prompts to paste into a Pi agent

Use one of these prompts when setting up a new machine or a fresh checkout.

```text
Read this repo's .pi/README.md and check which pi setup steps are needed on this machine.
Before running any install commands, summarize the missing required packages, skills, and CLIs, then ask for confirmation.
Do not modify items that are already installed. Also check whether a global warp-notify extension exists and could be loaded twice.
```

For a full setup handoff:

```text
Configure the pi environment using the quick setup section in .pi/README.md.
Check whether each item is already installed first, and install only the missing items.
After setup, verify with pi list, npx skills list -g --agent pi, and agent-browser --version.
```

For updates only:

```text
Use .pi/README.md to update the currently installed pi packages, global skills, and agent-browser.
Summarize versions before and after the update. Do not modify pinned packages or items that require manual review; report them instead.
```
