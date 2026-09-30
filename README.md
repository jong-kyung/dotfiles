# Personal macOS dotfiles

Development tools and AI configuration for Apple Silicon Macs. Setup copies files into your home directory, so the installed configuration does not depend on this repository's location.

## Install

Run `xcode-select --install` and wait for Command Line Tools to finish installing. Then:

```sh
git clone https://github.com/jong-kyung/dotfiles.git
cd dotfiles
./setup --dry-run
./setup
```

Run as your own user, without `sudo`. Homebrew may request administrator authentication. If setup stops at the AI stage because GitHub authentication is missing, sign in and resume:

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
./setup ai                   # AI tools, extensions, skills, and CodeGraph MCP
./setup --dry-run git ai     # Preview selected stages without changes
```

With no arguments, setup runs all stages in the order above. Run `brew` and `shell` before other stages on a new Mac. Rerun a stage after fixing an installation error. Exit code `2` means you declined configuration changes.

`setup` handles arguments and dispatches stages from `scripts/setup/`. Shared confirmation, backup, and copy helpers live in `scripts/setup/common.sh`.

See [Brewfile](Brewfile), the [Pi guide](pi/README.md), and the [Claude Code guide](claude/README.md) for the selected tools and settings. Setup leaves macOS system preferences alone.

[skills.json](skills.json) lists directly installed skills by repository and skill directory path. `./setup ai` installs missing entries for both Pi and Claude Code with `gh skill install`. Existing skills are preserved, and removing an entry does not uninstall it. Pi packages and Claude plugins are managed separately.

## Configuration and backups

Edit files in this repository and rerun the relevant stage. Setup skips identical files and asks before backing up and replacing existing files or symlinks. Git and JSON changes preserve unrelated settings. The Pi MCP settings merge disables unsupported legacy SSE servers after confirmation. Setup does not delete legacy files, packages, or plugins.

Backups live in `~/.local/state/dotfiles/backups/<run-id>/`, with paths relative to your home directory. Restore files from there when needed. Keep these private backups out of Git.

[AGENTS.md](AGENTS.md) is the shared instruction source. Setup copies it to Pi's `~/.pi/agent/AGENTS.md` and Claude's `~/.claude/CLAUDE.md`.

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
ruby -c Brewfile
./setup --dry-run
git diff --check
```

These checks do not run installers or verify live GPG, notification, or MCP connections.
