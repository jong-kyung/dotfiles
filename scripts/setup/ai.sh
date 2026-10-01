# Shared helpers for the independently selectable Pi and Claude Code stages.
pi_package() {
  local source=$1 installed=$2
  if node "$ROOT/scripts/setup-query.mjs" pi-has-package "$source" && [ -f "$installed/package.json" ]; then
    printf 'Installed Pi package: %s\n' "$source"
  else
    backup "$HOME/.pi/agent/settings.json"
    pi install "$source"
  fi
}

# Succeeds when the JSON array on stdin has an item whose key equals value, optionally in the given scope.
json_has() {
  node "$ROOT/scripts/setup-query.mjs" json-has "$@"
}

claude_plugin() {
  local repo=$1 marketplace=$2 plugin=$3 state
  state=$(claude plugin marketplace list --json | node "$ROOT/scripts/setup-query.mjs" claude-marketplace "$marketplace" "$repo") \
    || die "Cannot verify marketplace $marketplace. Resolve its source before retrying."
  if [ "$state" = missing ]; then
    backup "$HOME/.claude/settings.json"
    claude plugin marketplace add "$repo"
  fi

  if ! claude plugin list --json | json_has id "$plugin" user; then
    backup "$HOME/.claude/settings.json"
    claude plugin install "$plugin" --scope user
  fi
}

install_skills() {
  local agent=$1 directory=$2 repo skill name dest
  if $DRY_RUN; then
    printf 'Install missing skills from skills.json for %s; preserve existing skills.\n' "$agent"
    return
  fi

  while IFS=$'\t' read -r repo skill; do
    name=${skill##*/}
    dest="$directory/skills/$name"
    if [ -f "$dest/SKILL.md" ]; then
      printf 'Existing skill preserved: %s (use gh skill update separately)\n' "$dest"
    else
      gh skill install "$repo" "$skill" --agent "$agent" --scope user
    fi
  done < "$WORK/skills"
}

ai_prepare() {
  if ${AI_PREPARED:-false}; then
    return
  fi
  if $DRY_RUN; then
    log 'shared AI tools: CodeGraph, gh-stack extension and agent-browser Chrome'
    printf 'Install missing tools only.\n'
  else
    need node
    need gh
    need agent-browser
    node "$ROOT/scripts/setup-query.mjs" skills "$ROOT/skills.json" > "$WORK/skills"
    gh auth status >/dev/null 2>&1 || die 'Run gh auth login yourself, then retry (official skill installation requires GitHub access).'
    gh skill install --help >/dev/null 2>&1 || die 'Your gh lacks skill install. Upgrade gh explicitly, then retry.'

    if ! has codegraph; then
      installer https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh /bin/sh
    fi
    if ! gh extension list | grep -F 'github/gh-stack' >/dev/null; then
      gh extension install github/gh-stack
    fi
    agent-browser install
  fi
  AI_PREPARED=true
}
