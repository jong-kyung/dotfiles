# Shared helpers for the independently selectable Pi and Claude Code stages.
pi_package() {
  local source=$1 installed=$2 result=0 label=${1#npm:}
  node "$ROOT/scripts/setup-query.mjs" pi-has-package "$source" || result=$?
  [ "$result" -le 1 ] || die 'Cannot inspect Pi packages. Check ~/.pi/agent/settings.json.'
  if [ "$result" -eq 0 ] && [ -f "$installed/package.json" ]; then
    status EXISTS "Pi package: $label"
  else
    backup "$HOME/.pi/agent/settings.json"
    status INSTALLING "Pi package: $label"
    pi install "$source"
    status INSTALLED "Pi package: $label"
  fi
}

claude_plugin() {
  local repo=$1 marketplace=$2 plugin=$3 state result=0
  state=$(claude plugin marketplace list --json | node "$ROOT/scripts/setup-query.mjs" claude-marketplace "$marketplace" "$repo") \
    || die "Cannot verify marketplace $marketplace. Resolve its source before retrying."
  if [ "$state" = missing ]; then
    backup "$HOME/.claude/settings.json"
    status INSTALLING "Claude marketplace: $marketplace"
    claude plugin marketplace add "$repo"
    status INSTALLED "Claude marketplace: $marketplace"
  else
    status EXISTS "Claude marketplace: $marketplace"
  fi

  claude plugin list --json > "$WORK/claude-plugins.json" || die 'Cannot list Claude plugins.'
  node "$ROOT/scripts/setup-query.mjs" json-has id "$plugin" user < "$WORK/claude-plugins.json" || result=$?
  [ "$result" -le 1 ] || die 'Cannot inspect Claude plugin settings.'
  if [ "$result" -eq 0 ]; then
    status EXISTS "Claude plugin: $plugin"
  else
    backup "$HOME/.claude/settings.json"
    status INSTALLING "Claude plugin: $plugin"
    claude plugin install "$plugin" --scope user
    status INSTALLED "Claude plugin: $plugin"
  fi
}

github_ready() {
  if [ "${GITHUB_READY:-false}" = true ]; then
    return
  fi
  gh auth status >/dev/null 2>&1 || die 'Run gh auth login yourself, then retry the missing GitHub installations.'
  GITHUB_READY=true
}

install_skills() {
  local agent=$1 directory=$2 repo skill dest ready=false
  while IFS=$'\t' read -r repo skill; do
    [ -n "$repo" ] || continue
    dest="$directory/skills/$skill"
    if [ -f "$dest/SKILL.md" ]; then
      status EXISTS "Skill: $dest"
    else
      if ! $ready; then
        github_ready
        gh skill install --help >/dev/null 2>&1 || die 'Your gh lacks skill install. Upgrade gh explicitly, then retry.'
        ready=true
      fi
      status INSTALLING "Skill: $dest"
      gh skill install "$repo" "$skill" --agent "$agent" --scope user
      status INSTALLED "Skill: $dest"
    fi
  done <<< "$SKILLS"
}

ai_prepare() {
  local extensions
  if ${AI_PREPARED:-false}; then
    return
  fi
  GITHUB_READY=false
  need node
  need gh
  if ! has codegraph; then
    installer https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh /bin/sh
  else
    status EXISTS CodeGraph
  fi
  extensions=$(gh extension list) || die 'Cannot list GitHub CLI extensions.'
  if printf '%s\n' "$extensions" | grep -E '(^|[[:space:]])github/gh-stack([[:space:]]|$)' >/dev/null; then
    status EXISTS gh-stack
  else
    github_ready
    status INSTALLING gh-stack
    gh extension install github/gh-stack
    status INSTALLED gh-stack
  fi
  AI_PREPARED=true
}
