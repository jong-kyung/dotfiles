# Personal macOS dotfiles

Development tools and AI configuration for Apple Silicon Macs. Setup copies files into your home directory, so the installed configuration does not depend on this repository's location.

## Install

Run `xcode-select --install` and wait for Command Line Tools to finish installing. Then:

```sh
git clone https://github.com/jong-kyung/dotfiles.git
cd dotfiles
./setup --dry-run brew shell
./setup brew shell
./setup --dry-run
./setup
```

Run as your own user, without `sudo`. `./setup` shows a numbered menu. Enter comma-separated numbers such as `1,3,5`, or `all` for everything. Empty input cancels, and invalid input prompts again. Review the selected work and approve it once. Homebrew and other external installers may still request authentication.

If setup stops at an AI stage because GitHub authentication is missing, sign in and resume:

```sh
gh auth login
./setup ai
```

Sign in to Pi and Claude Code yourself after installation. Setup does not copy credentials, private keys, or conversation history.

## Stages

```sh
./setup brew                 # Homebrew and Brewfile packages
./setup shell                # Vite+, Bun, Rust, Oh My Zsh, and .zshrc
./setup git                  # Shared Git preferences and GPG pinentry
./setup ghostty              # Ghostty configuration
./setup pi                   # Pi packages, extensions, skills, and CodeGraph MCP
./setup claude               # Claude Code plugins, hooks, skills, and CodeGraph MCP
./setup ai                   # Both Pi and Claude Code
./setup --dry-run git pi     # Preview selected stages without changes
```

The menu numbers are `1` for Homebrew, `2` for Shell, `3` for Git, `4` for Ghostty, `5` for Pi, and `6` for Claude Code. Selected stages run once each in that order, regardless of input order. Explicit stage arguments skip the menu but still require one approval. `--dry-run` never prompts and previews all stages when none are specified. Actual installation requires an interactive terminal.

Run `brew` and `shell` before other stages on a new Mac. Pi and Claude Code require Node even for a preview because their JSON installation lists are read before approval. If Node is missing, setup asks you to run `./setup brew shell` first and stops without changes. Rerun a stage after fixing an installation error. Cancelling exits without changes.

Only status labels are colored. Successful changes are green, existing or unchanged items are cyan, cancellations and warnings are yellow, and errors are red. Descriptions keep the terminal's default color. Redirected output, `TERM=dumb`, and `NO_COLOR` disable colors. External installers keep their own output.

`setup` handles arguments and dispatches stages from `scripts/setup/`. Shared confirmation, backup, and copy helpers live in `scripts/setup/common.sh`.

See [Brewfile](Brewfile), the [Pi guide](pi/README.md), and the [Claude Code guide](claude/README.md) for the selected tools and settings. Setup leaves macOS system preferences alone.

[pi.json](pi.json) lists Pi package sources, [claude.json](claude.json) lists Claude plugin repositories, marketplaces, and IDs, and [skills.json](skills.json) lists skill repositories and short names. Setup validates the selected lists before approval and uses them for both preview and installation. Pi sources retain their `npm:` prefix for installation but omit it in setup labels. Each AI stage installs missing skills for its own agent with `gh skill install`. Existing installations are preserved, and removing a list entry does not uninstall it. CLI installers, shared AI tools, Herdr integration, and file deployment remain in the shell scripts.

Homebrew checks the Brewfile without upgrades and skips installation when all dependencies are present. AI stages request GitHub authentication only for missing GitHub extensions or skills. Failed Pi, Claude or GitHub extension queries stop setup rather than trigger a reinstall.

Homebrew installs the agent-browser CLI, but setup does not inspect or install browsers. Prepare a compatible browser yourself before using agent-browser.

## Configuration and backups

Edit files in this repository and rerun the relevant stage. Setup previews the affected paths before the single approval, then backs up and replaces existing files or symlinks without further per-file questions. Identical files are skipped. Git and JSON changes preserve unrelated settings. Approving Pi includes normalizing and disabling unsupported legacy SSE servers. Approving Claude Code includes removing managed legacy notify hook commands from settings. Setup does not delete legacy files, packages, or plugins.

Backups live in `~/.local/state/dotfiles/backups/<run-id>/`, with paths relative to your home directory. Restore files from there when needed. Keep these private backups out of Git.

[AGENTS.md](AGENTS.md) is the shared instruction source. Setup copies it to Pi's `~/.pi/agent/AGENTS.md` and Claude's `~/.claude/CLAUDE.md`.

Setup restores the original terminal settings before confirmation, between stages, and on exit so external commands cannot leave the next prompt in raw mode.

Setup uses standard home-directory paths. Custom `PI_CODING_AGENT_DIR`, `CLAUDE_CONFIG_DIR`, and `GNUPGHOME` locations are not supported.

## Manual steps

- Remove unwanted legacy integrations yourself, including custom CodeGraph extensions and skills, old `gh-cli` skills, and `gh-cli@kit`. Setup preserves them.
- Configure your Git identity and signing with `git config --global`. Setup preserves those settings and existing includes; it does not create a separate identity file.
- Prepare your signing key yourself. Restart an existing GPG agent with `gpgconf --kill gpg-agent` to apply pinentry changes.
- Open a new terminal and restart Pi and Claude Code. Sign in and select your models.
- Check CodeGraph with `pi mcp list` and Claude's `/mcp`. Run `codegraph init` yourself in each project you want to index.

## Updates

Setup uses official installers for Vite+, Bun, Rust, Oh My Zsh, Claude Code, and CodeGraph. It uses documented package-manager commands for the remaining tools, including Homebrew for Mole and Herdr. Existing installations stay in place without automatic upgrades. New installations use each official installer's stable release or default Git ref. Update tools separately through their package managers, such as `brew upgrade`, `vp update -g`, `pi update --extensions`, `claude update`, and `gh skill update --all`.

## Local checks

```sh
for file in setup scripts/setup/*.sh; do
  /bin/bash -n "$file"
done
zsh -n zsh/zshrc
node --check scripts/config.mjs
node --check scripts/setup-query.mjs
ruby -c Brewfile
./setup --dry-run
git diff --check
```

These checks do not run installers or verify live GPG, notification, or MCP connections.
