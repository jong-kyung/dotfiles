git_stage() {
  need git
  need gpg
  need pinentry-mac
  need delta

  local entry key
  [ ! -f "$HOME/.gitconfig" ] || cp "$HOME/.gitconfig" "$WORK/gitconfig"
  git config --file "$ROOT/git/gitconfig" --null --list | while IFS= read -r -d '' entry; do
    key=${entry%%$'\n'*}
    git config --file "$WORK/gitconfig" --replace-all "$key" "${entry#*$'\n'}"
  done
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
