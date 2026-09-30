pi_source() {
  node "$ROOT/scripts/setup-query.mjs" pi-source "$1"
}

pi_package() {
  local source=$1 installed=$2
  if [ -n "$(pi_source "$source")" ] && [ -f "$installed/package.json" ]; then
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
  local repo=$1 marketplace=$2 plugin=$3
  if ! claude plugin marketplace list --json | json_has name "$marketplace"; then
    backup "$HOME/.claude/settings.json"
    claude plugin marketplace add "$repo"
  fi

  if ! claude plugin list --json | json_has id "$plugin" user; then
    backup "$HOME/.claude/settings.json"
    claude plugin install "$plugin" --scope user
  fi
}

install_skill() {
  local repo=$1 skill=$2 name=$3 pair dest
  for pair in "pi:$HOME/.pi/agent" "claude-code:$HOME/.claude"; do
    dest="${pair#*:}/skills/$name"
    if [ -f "$dest/SKILL.md" ]; then
      printf 'Existing skill preserved: %s (use gh skill update separately)\n' "$dest"
    else
      gh skill install "$repo" "$skill" --agent "${pair%%:*}" --scope user
    fi
  done
}

ai_stage() {
  local file source before
  if $DRY_RUN; then
    log 'ai: Pi, Claude Code, CodeGraph official MCP, ccstatusline; selected packages and official skills; no Figma/Jira'
    log 'ai: confirm conflicting pi-mcp-adapter, custom codegraph and legacy gh-cli/notify resources before removal'
  else
    need vp
    need node
    need bun
    need gh
    need agent-browser
    gh auth status >/dev/null 2>&1 || die 'Run gh auth login yourself, then rerun ./setup ai (official skill installation requires GitHub access).'
    gh skill install --help >/dev/null 2>&1 || die 'Your gh lacks skill install. Upgrade gh explicitly, then retry.'

    if ! has pi; then
      vp install -g @earendil-works/pi-coding-agent --ignore-scripts
    fi
    if ! has claude; then
      installer https://claude.ai/install.sh /bin/bash stable
    fi
    if ! has codegraph; then
      installer https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh /bin/sh
    fi
    if ! has ccstatusline; then
      bun install -g ccstatusline
    fi
    pi mcp --help >/dev/null 2>&1 || die 'Pi needs native MCP support. Upgrade Pi explicitly, then retry.'

    # Approve transport changes and native MCP activation before removing the working adapter.
    before=$PENDING
    merge_json pi-mcp "$HOME/.pi/agent/mcp.json"
    [ "$PENDING" -eq "$before" ] || die 'Native MCP configuration was declined; adapter removal was not attempted.'
    merge_json pi "$HOME/.pi/agent/settings.json"
    [ "$PENDING" -eq "$before" ] || die 'Native MCP activation was declined; adapter removal was not attempted.'
    source=$(pi_source npm:pi-mcp-adapter)
    if [ -n "$source" ]; then
      confirm 'Remove pi-mcp-adapter so Pi native MCP can run?' || die 'Pi native MCP is blocked by the adapter.'
      backup "$HOME/.pi/agent/settings.json"
      pi remove "$source"
    fi

    retire "$HOME/.pi/agent/extensions/codegraph.ts"
    retire "$HOME/.pi/agent/skills/codegraph"
    retire "$HOME/.claude/skills/codegraph"
    retire "$HOME/.agents/skills/codegraph"
    retire "$HOME/.pi/agent/skills/gh-cli"
    retire "$HOME/.claude/skills/gh-cli"
    retire "$HOME/.agents/skills/gh-cli"
    if claude plugin list --json | json_has id gh-cli@kit user; then
      confirm 'Remove gh-cli@kit in favor of the official gh skill?' || die 'Resolve the duplicate gh-cli plugin first.'
      backup "$HOME/.claude/settings.json"
      claude plugin uninstall gh-cli@kit --scope user
    fi

    pi_package npm:pi-subagents "$HOME/.pi/agent/npm/node_modules/pi-subagents"
    pi_package npm:pi-ask-user "$HOME/.pi/agent/npm/node_modules/pi-ask-user"
    pi_package git:github.com/DietrichGebert/ponytail "$HOME/.pi/agent/git/github.com/DietrichGebert/ponytail"
    pi_package git:github.com/EveryInc/compound-engineering-plugin "$HOME/.pi/agent/git/github.com/EveryInc/compound-engineering-plugin"
    claude_plugin DietrichGebert/ponytail ponytail ponytail@ponytail
    claude_plugin EveryInc/compound-engineering-plugin compound-engineering-plugin compound-engineering@compound-engineering-plugin

    if ! gh extension list | grep -F 'github/gh-stack' >/dev/null; then
      gh extension install github/gh-stack
    fi
    install_skill cli/cli skills/gh gh
    install_skill github/gh-stack skills/gh-stack gh-stack
    install_skill vercel-labs/agent-browser skills/agent-browser agent-browser
    install_skill mattpocock/skills skills/productivity/grilling grilling
    install_skill mattpocock/skills skills/productivity/grill-me grill-me
    agent-browser install

    # Herdr owns this generated integration; do not vendor its files here.
    if [ ! -f "$HOME/.pi/agent/extensions/herdr-agent-state.ts" ]; then
      need herdr
      herdr integration install pi
    fi
  fi

  copy_file "$ROOT/AGENTS.md" "$HOME/.pi/agent/AGENTS.md"
  copy_file "$ROOT/AGENTS.md" "$HOME/.claude/CLAUDE.md"
  for file in context files loop notify readonly-gh-api session-breakdown; do
    copy_file "$ROOT/pi/extensions/$file.ts" "$HOME/.pi/agent/extensions/$file.ts"
  done
  copy_file "$ROOT/claude/hooks/readonly-gh-api.ts" "$HOME/.claude/hooks/readonly-gh-api.ts"
  copy_file "$ROOT/claude/ccstatusline/settings.json" "$HOME/.config/ccstatusline/settings.json"
  if $DRY_RUN; then
    merge_json pi-mcp "$HOME/.pi/agent/mcp.json"
    merge_json pi "$HOME/.pi/agent/settings.json"
  fi
  merge_json claude-mcp "$HOME/.claude.json"
  merge_json claude "$HOME/.claude/settings.json"

  if ! $DRY_RUN; then
    pi --version
    claude --version
    codegraph --version
    pi list
    printf 'Restart Pi/Claude. Sign in manually. Run pi mcp list and Claude /mcp to verify CodeGraph.\n'
    printf 'Project indexes are opt-in: run codegraph init in each chosen project yourself.\n'
  fi
}
