ghostty_stage() {
  copy_file "$ROOT/ghostty/config.ghostty" "${XDG_CONFIG_HOME:-$HOME/.config}/ghostty/config.ghostty"
}
