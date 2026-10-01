brew_stage() {
  xcode-select -p >/dev/null 2>&1 || die 'Install Command Line Tools with xcode-select --install, then retry.'
  if ! has brew; then
    installer https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh /bin/bash
  else
    status EXISTS Homebrew
  fi

  need brew
  if HOMEBREW_NO_AUTO_UPDATE=1 brew bundle check --file="$ROOT/Brewfile" --no-upgrade >/dev/null; then
    status EXISTS 'All Brewfile dependencies'
  else
    status INSTALLING 'Missing Brewfile dependencies'
    HOMEBREW_NO_AUTO_UPDATE=1 brew bundle install --file="$ROOT/Brewfile" --no-upgrade
    status INSTALLED 'Brewfile dependencies'
  fi
}
