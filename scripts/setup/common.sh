log() {
  printf '\n==> %s\n' "$*"
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

has() {
  command -v "$1" >/dev/null 2>&1
}

need() {
  has "$1" || die "Missing $1. Run ./setup brew shell first, then retry this stage."
}

confirm() {
  local answer
  printf '%s [y/N] ' "$*" >&2
  IFS= read -r answer || return 1

  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

pending() {
  printf 'Skipped: %s\n' "$*" >&2
  PENDING=$((PENDING + 1))
}

backup() {
  local target=$1 saved
  [ -e "$target" ] || [ -L "$target" ] || return 0

  case "$target" in
    "$HOME"/*) ;;
    *) die "Refusing backup outside HOME: $target" ;;
  esac

  if [ -z "$BACKUPS" ]; then
    mkdir -p "$HOME/.local/state/dotfiles/backups"
    BACKUPS=$(mktemp -d "$HOME/.local/state/dotfiles/backups/$(date +%Y%m%d-%H%M%S).XXXXXX")
  fi

  saved="$BACKUPS/${target#"$HOME"/}"
  if [ ! -e "$saved" ] && [ ! -L "$saved" ]; then
    mkdir -p "$(dirname "$saved")"
    cp -pPR "$target" "$saved"
  fi
}

copy_file() {
  local source=$1 target=$2 temp
  if $DRY_RUN; then
    printf 'Copy: %s -> %s\n' "${source#"$ROOT"/}" "$target"
    return
  fi

  if [ -f "$target" ] && [ ! -L "$target" ] && cmp -s "$source" "$target"; then
    printf 'Unchanged: %s\n' "$target"
    return
  fi

  [ ! -d "$target" ] || die "Expected a file, found a directory: $target"
  if [ -e "$target" ] || [ -L "$target" ]; then
    if ! confirm "Back up and replace $target?"; then
      pending "$target"
      return
    fi
    backup "$target"
  fi

  mkdir -p "$(dirname "$target")"
  temp=$(mktemp "$target.tmp.XXXXXX")
  if ! cp "$source" "$temp" || ! mv -f "$temp" "$target"; then
    rm -f "$temp"
    die "Could not copy $target (backup preserved)."
  fi
  printf 'Copied: %s\n' "$target"
}

merge_json() {
  local mode=$1 target=$2
  if $DRY_RUN; then
    printf 'Merge managed %s settings: %s\n' "$mode" "$target"
    return
  fi

  node "$ROOT/scripts/config.mjs" "$mode" "$target" > "$WORK/config.json"
  copy_file "$WORK/config.json" "$target"
}

installer() {
  local url=$1 interpreter=$2
  shift 2
  log "Official installer: $url"
  curl --proto '=https' --tlsv1.2 -fsSL "$url" -o "$WORK/installer"
  "$interpreter" "$WORK/installer" "$@"
}
