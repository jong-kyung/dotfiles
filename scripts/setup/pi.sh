pi_stage() {
  local file source installed
  ai_prepare
  if ! has pi; then
    need vp
    status INSTALLING Pi
    vp install -g @earendil-works/pi-coding-agent --ignore-scripts
    status INSTALLED Pi
  else
    status EXISTS Pi
  fi
  pi mcp --help >/dev/null 2>&1 || die 'Pi needs native MCP support. Upgrade Pi explicitly, then retry.'

  merge_json pi-mcp "$HOME/.pi/agent/mcp.json"
  merge_json pi "$HOME/.pi/agent/settings.json"
  while IFS=$'\t' read -r source installed; do
    [ -n "$source" ] || continue
    pi_package "$source" "$HOME/.pi/agent/$installed"
  done <<< "$PI_PACKAGES"

  # Herdr owns this generated integration; do not vendor its files here.
  if [ ! -f "$HOME/.pi/agent/extensions/herdr-agent-state.ts" ]; then
    need herdr
    status INSTALLING 'Herdr Pi integration'
    herdr integration install pi
    status INSTALLED 'Herdr Pi integration'
  else
    status EXISTS 'Herdr Pi integration'
  fi
  install_skills pi "$HOME/.pi/agent"
  copy_file "$ROOT/AGENTS.md" "$HOME/.pi/agent/AGENTS.md"
  for file in context files loop notify readonly-gh-api session-breakdown; do
    copy_file "$ROOT/pi/extensions/$file.ts" "$HOME/.pi/agent/extensions/$file.ts"
  done

  pi --version
  pi list
  codegraph --version
  printf 'Restart Pi. Sign in manually. Run pi mcp list to verify CodeGraph.\n'
  printf 'Project indexes are opt-in: run codegraph init in each chosen project yourself.\n'
}
