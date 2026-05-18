# Skill Manager

`skill-manager` adds conservative lifecycle commands for Pi skills, plugin bundles, and Pi packages.

## Commands

```text
/skill-status <target>
/skill-update <target>
/skill-remove <target> [--global]
```

## What it does

- Discovers lifecycle targets from local Pi state:
  - plugin bundle manifests (`install-manifest.json`)
  - Pi package settings
  - safe local `npx skills` lock metadata
  - loaded runtime commands and loose skill folders
- Reports target ownership, source, resources, and supported actions without mutating anything.
- Builds explicit update/remove plans before running any supported mutation.
- Requires confirmation before external package-manager commands.
- Revalidates target ownership immediately before mutation.
- Writes a receipt and reloads Pi when resources may have changed.

## Safety model

The extension is intentionally conservative: automatic mutation is supported only when ownership and source identity are exact enough to avoid touching the wrong resource.

Supported automatic updates:

- verified local `npx skills` entries via the pinned `skills@1.5.7` CLI
- exact-one unpinned npm/git Pi package entries

Guidance-only cases include:

- plugin bundles and bundle members without updater metadata
- pinned, duplicate, local, malformed, or ambiguous Pi packages
- unverified `npx skills` entries
- global `npx skills` removal
- loose skills and runtime-command-only targets

Use `/skill-status <target>` first when unsure which manager owns a skill or command.
