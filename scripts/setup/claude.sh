claude_stage() {
  local repo marketplace plugin
  ai_prepare
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

  while IFS=$'\t' read -r repo marketplace plugin; do
    [ -n "$repo" ] || continue
    claude_plugin "$repo" "$marketplace" "$plugin"
  done <<< "$CLAUDE_PLUGINS"

  install_skills claude-code "$HOME/.claude"
  copy_file "$ROOT/AGENTS.md" "$HOME/.claude/CLAUDE.md"
  copy_file "$ROOT/claude/hooks/readonly-gh-api.ts" "$HOME/.claude/hooks/readonly-gh-api.ts"
  copy_file "$ROOT/claude/ccstatusline/settings.json" "$HOME/.config/ccstatusline/settings.json"
  merge_json claude-mcp "$HOME/.claude.json"
  merge_json claude "$HOME/.claude/settings.json"

  claude --version
  codegraph --version
  printf 'Restart Claude. Sign in manually. Run /mcp to verify CodeGraph.\n'
  printf 'Project indexes are opt-in: run codegraph init in each chosen project yourself.\n'
}
