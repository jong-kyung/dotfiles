ghostty_stage() {
  local legacy="$HOME/Library/Application Support/com.mitchellh.ghostty/config"
  copy_file "$ROOT/ghostty/config.ghostty" "${XDG_CONFIG_HOME:-$HOME/.config}/ghostty/config.ghostty"
  if [ -e "$legacy" ] || [ -L "$legacy" ]; then
    backup "$legacy"
    rm -f "$legacy"
    status UPDATED "Removed legacy $legacy"
  fi
}
