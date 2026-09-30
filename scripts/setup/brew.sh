brew_stage() {
  if $DRY_RUN; then
    log 'brew: Homebrew if missing, then Brewfile without upgrades'
    return
  fi

  xcode-select -p >/dev/null 2>&1 || die 'Install Command Line Tools with xcode-select --install, then retry.'
  if ! has brew; then
    installer https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh /bin/bash
  fi

  need brew
  HOMEBREW_NO_AUTO_UPDATE=1 brew bundle install --file="$ROOT/Brewfile" --no-upgrade
}
