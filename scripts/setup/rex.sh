rex_stage() {
  copy_file "$ROOT/rex/init.lua" "${XDG_CONFIG_HOME:-$HOME/.config}/rex/init.lua"
  printf 'Run rex config reload to apply it to a running Rex.\n'
}
