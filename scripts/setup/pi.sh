pi_stage() {
  local file
  ai_prepare
  if $DRY_RUN; then
    log 'Pi: CLI, pi-subagents, pi-ask-user, Ponytail, Compound Engineering and Herdr integration'
    printf 'Enable native MCP and normalize and disable legacy SSE servers. Preserve other preferences.\n'
  else
    if ! has pi; then
      need vp
      vp install -g @earendil-works/pi-coding-agent --ignore-scripts
    fi
    pi mcp --help >/dev/null 2>&1 || die 'Pi needs native MCP support. Upgrade Pi explicitly, then retry.'
  fi

  merge_json pi-mcp "$HOME/.pi/agent/mcp.json"
  merge_json pi "$HOME/.pi/agent/settings.json"
  if ! $DRY_RUN; then
    pi_package npm:pi-subagents "$HOME/.pi/agent/npm/node_modules/pi-subagents"
    pi_package npm:pi-ask-user "$HOME/.pi/agent/npm/node_modules/pi-ask-user"
    pi_package git:github.com/DietrichGebert/ponytail "$HOME/.pi/agent/git/github.com/DietrichGebert/ponytail"
    pi_package git:github.com/EveryInc/compound-engineering-plugin "$HOME/.pi/agent/git/github.com/EveryInc/compound-engineering-plugin"

    # Herdr owns this generated integration; do not vendor its files here.
    if [ ! -f "$HOME/.pi/agent/extensions/herdr-agent-state.ts" ]; then
      need herdr
      herdr integration install pi
    fi
  fi
  install_skills pi "$HOME/.pi/agent"
  copy_file "$ROOT/AGENTS.md" "$HOME/.pi/agent/AGENTS.md"
  for file in context files loop notify readonly-gh-api session-breakdown; do
    copy_file "$ROOT/pi/extensions/$file.ts" "$HOME/.pi/agent/extensions/$file.ts"
  done

  if ! $DRY_RUN; then
    pi --version
    pi list
    codegraph --version
    printf 'Restart Pi. Sign in manually. Run pi mcp list to verify CodeGraph.\n'
    printf 'Project indexes are opt-in: run codegraph init in each chosen project yourself.\n'
  fi
}
