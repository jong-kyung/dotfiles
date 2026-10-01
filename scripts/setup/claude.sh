claude_stage() {
  local repo marketplace plugin
  ai_prepare
  if $DRY_RUN; then
    log 'Claude Code: CLI, plugins from claude.json, ccstatusline'
    printf 'Configure the gh API guard, built-in notifications and attribution preferences.\n'
    printf 'Remove managed legacy notify hook commands from settings; keep hook files.\n'
  else
    need bun
    if ! has claude; then
      installer https://claude.ai/install.sh /bin/bash stable
    else
      status EXISTS 'Claude Code'
    fi
    if ! has ccstatusline; then
      status INSTALLING ccstatusline
      bun install -g ccstatusline
      status INSTALLED ccstatusline
    else
      status EXISTS ccstatusline
    fi
  fi

  while IFS=$'\t' read -r repo marketplace plugin; do
    [ -n "$repo" ] || continue
    if $DRY_RUN; then
      status PLAN "Claude plugin: $plugin ($repo)"
    else
      claude_plugin "$repo" "$marketplace" "$plugin"
    fi
  done <<< "$CLAUDE_PLUGINS"

  install_skills claude-code "$HOME/.claude"
  copy_file "$ROOT/AGENTS.md" "$HOME/.claude/CLAUDE.md"
  copy_file "$ROOT/claude/hooks/readonly-gh-api.ts" "$HOME/.claude/hooks/readonly-gh-api.ts"
  copy_file "$ROOT/claude/ccstatusline/settings.json" "$HOME/.config/ccstatusline/settings.json"
  merge_json claude-mcp "$HOME/.claude.json"
  merge_json claude "$HOME/.claude/settings.json"

  if ! $DRY_RUN; then
    claude --version
    codegraph --version
    printf 'Restart Claude. Sign in manually. Run /mcp to verify CodeGraph.\n'
    printf 'Project indexes are opt-in: run codegraph init in each chosen project yourself.\n'
  fi
}
