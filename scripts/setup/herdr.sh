herdr_stage() {
  copy_file "$ROOT/herdr/config.toml" "${XDG_CONFIG_HOME:-$HOME/.config}/herdr/config.toml"
  printf 'Run herdr server reload-config or press prefix+shift+r to apply it to a running Herdr.\n'
}
