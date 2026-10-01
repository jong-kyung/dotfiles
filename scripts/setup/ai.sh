# Shared helpers for the independently selectable Pi and Claude Code stages.
pi_package() {
  local source=$1 installed=$2 result=0
  node "$ROOT/scripts/setup-query.mjs" pi-has-package "$source" || result=$?
  [ "$result" -le 1 ] || die 'Cannot inspect Pi packages. Check ~/.pi/agent/settings.json.'
  if [ "$result" -eq 0 ] && [ -f "$installed/package.json" ]; then
    status EXISTS "Pi package: $source"
  else
    backup "$HOME/.pi/agent/settings.json"
    status INSTALLING "Pi package: $source"
    pi install "$source"
    status INSTALLED "Pi package: $source"
  fi
}

# Succeeds when the JSON array on stdin has an item whose key equals value, optionally in the given scope.
json_has() {
  node "$ROOT/scripts/setup-query.mjs" json-has "$@"
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
  json_has id "$plugin" user < "$WORK/claude-plugins.json" || result=$?
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
  local agent=$1 directory=$2 repo skill name dest ready=false
  if $DRY_RUN; then
    printf 'Install missing skills from skills.json for %s; preserve existing skills.\n' "$agent"
    return
  fi

  while IFS=$'\t' read -r repo skill; do
    name=${skill##*/}
    dest="$directory/skills/$name"
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
  done < "$WORK/skills"
}

install_browser() {
  local browser
  if [ -n "${AGENT_BROWSER_EXECUTABLE_PATH:-}" ]; then
    [ -f "$AGENT_BROWSER_EXECUTABLE_PATH" ] && [ -x "$AGENT_BROWSER_EXECUTABLE_PATH" ] \
      || die "Browser is not executable: $AGENT_BROWSER_EXECUTABLE_PATH"
  fi
  # Match agent-browser 0.38.1 macOS discovery without running doctor, which cleans daemon files.
  for browser in \
    "${AGENT_BROWSER_EXECUTABLE_PATH:-}" \
    "$HOME/.agent-browser/browsers"/chrome-*/"Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" \
    "$HOME/.agent-browser/browsers"/chrome-*/chrome-mac-{arm64,x64}/"Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" \
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary' \
    '/Applications/Chromium.app/Contents/MacOS/Chromium' \
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' \
    "${PUPPETEER_CACHE_DIR:-$HOME/.cache/puppeteer}"/chrome/*/chrome-mac-{arm64,x64}/"Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" \
    "$HOME/.cache/puppeteer"/chrome/*/chrome-mac-{arm64,x64}/"Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" \
    "${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"/chromium-*/"chrome-mac/Chromium.app/Contents/MacOS/Chromium" \
    "$HOME/.cache/ms-playwright"/chromium-*/"chrome-mac/Chromium.app/Contents/MacOS/Chromium"; do
    if [ -f "$browser" ] && [ -x "$browser" ]; then
      status EXISTS "Browser: $browser"
      return
    fi
  done
  status INSTALLING 'agent-browser Chrome'
  agent-browser install
  status INSTALLED 'agent-browser Chrome'
}

ai_prepare() {
  local extensions
  if ${AI_PREPARED:-false}; then
    return
  fi
  if $DRY_RUN; then
    log 'shared AI tools: CodeGraph, gh-stack extension and agent-browser Chrome'
    printf 'Install missing tools only and reuse an existing browser.\n'
  else
    GITHUB_READY=false
    need node
    need gh
    need agent-browser
    node "$ROOT/scripts/setup-query.mjs" skills "$ROOT/skills.json" > "$WORK/skills" || die 'Cannot read skills.json.'

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
    install_browser
  fi
  AI_PREPARED=true
}
