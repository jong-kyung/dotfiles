claude_stage() {
  ai_prepare
  if $DRY_RUN; then
    log 'Claude Code: CLI, Ponytail and Compound Engineering plugins, ccstatusline'
    printf 'Configure the gh API guard, built-in notifications and attribution preferences.\n'
    printf 'Remove managed legacy notify hook commands from settings; keep hook files.\n'
  else
    need bun
    if ! has claude; then
      installer https://claude.ai/install.sh /bin/bash stable
    fi
    if ! has ccstatusline; then
      bun install -g ccstatusline
    fi
    claude_plugin DietrichGebert/ponytail ponytail ponytail@ponytail
    claude_plugin EveryInc/compound-engineering-plugin compound-engineering-plugin compound-engineering@compound-engineering-plugin
  fi

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
