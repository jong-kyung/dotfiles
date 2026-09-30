git_stage() {
  if $DRY_RUN; then
    log 'git: merge shared preferences into ~/.gitconfig, preserve identity/signing/includes, and configure GPG pinentry'
    return
  fi

  need git
  need gpg
  need pinentry-mac
  need delta
  git help --config | grep -Fx 'pull.autoStash' >/dev/null || die 'This Git lacks pull.autoStash. Install or explicitly upgrade Homebrew Git first.'

  local entry key
  if [ -f "$HOME/.gitconfig" ]; then
    cp "$HOME/.gitconfig" "$WORK/gitconfig"
  else
    : > "$WORK/gitconfig"
  fi

  git config --file "$ROOT/git/gitconfig" --null --list > "$WORK/git-defaults"
  while IFS= read -r -d '' entry; do
    key=${entry%%$'\n'*}
    git config --file "$WORK/gitconfig" --replace-all "$key" "${entry#*$'\n'}"
  done < "$WORK/git-defaults"
  copy_file "$WORK/gitconfig" "$HOME/.gitconfig"

  mkdir -p "$HOME/.gnupg"
  chmod 700 "$HOME/.gnupg"
  local agent="$HOME/.gnupg/gpg-agent.conf"
  if [ -f "$agent" ]; then
    grep -vE '^[[:space:]]*pinentry-program([[:space:]]|$)' "$agent" > "$WORK/gpg-agent.conf" || [ "$?" -eq 1 ]
  fi
  printf 'pinentry-program %s\n' "$(command -v pinentry-mac)" >> "$WORK/gpg-agent.conf"
  copy_file "$WORK/gpg-agent.conf" "$agent"
}
