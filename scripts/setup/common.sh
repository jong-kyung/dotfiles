log() {
  printf '\n==> %s\n' "$*"
}

status() {
  local label=$1 color
  shift
  case "$label" in
    INSTALLED|UPDATED|DONE) color=32 ;;
    EXISTS|UNCHANGED) color=36 ;;
    CANCELLED|WARNING) color=33 ;;
    ERROR) color=31 ;;
    *) color=34 ;;
  esac
  if [ -t 1 ] && [ "${TERM:-dumb}" != dumb ] && [ -z "${NO_COLOR+x}" ]; then
    printf '\033[%sm[%s]\033[0m %s\n' "$color" "$label" "$*"
  else
    printf '[%s] %s\n' "$label" "$*"
  fi
}

die() {
  status ERROR "$*" >&2
  exit 1
}

has() {
  command -v "$1" >/dev/null 2>&1
}

need() {
  has "$1" || die "Missing $1. Run ./setup brew shell first, then retry this stage."
}

restore_terminal() {
  if [ -n "$TERMINAL_STATE" ]; then
    stty "$TERMINAL_STATE" </dev/tty || true
  fi
}

confirm() {
  restore_terminal
  local answer
  printf '%s [y/N] ' "$*" >&2
  IFS= read -r answer || return 1

  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

select_stages() {
  local choice i
  printf '\n1. Homebrew\n2. Shell\n3. Git\n4. Ghostty\n5. Pi\n6. Claude Code\n'
  printf 'On a new Mac, select Homebrew and Shell before other stages.\n'
  while true; do
    printf '\nSelect numbers separated by commas (1,3,5), all, or Enter to cancel: '
    IFS= read -r choice || choice=
    choice=${choice//[[:space:]]/}
    case "$choice" in
      '') status CANCELLED 'Nothing changed.'; exit 0 ;;
      all) STAGES=("${ALL_STAGES[@]}"); return ;;
    esac
    if [[ ! "$choice" =~ ^[1-6](,[1-6])*$ ]]; then
      status WARNING 'Use numbers 1 through 6 separated by commas, or all.' >&2
      continue
    fi
    STAGES=()
    for i in "${!ALL_STAGES[@]}"; do
      case ",$choice," in
        *",$((i + 1)),"*) STAGES+=("${ALL_STAGES[$i]}") ;;
      esac
    done
    return
  done
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
  local source=$1 target=$2 temp result=INSTALLED
  if [ -f "$target" ] && [ ! -L "$target" ] && cmp -s "$source" "$target"; then
    status UNCHANGED "$target"
    return
  fi

  [ ! -d "$target" ] || die "Expected a file, found a directory: $target"
  if [ -e "$target" ] || [ -L "$target" ]; then
    result=UPDATED
  fi
  if $DRY_RUN; then
    if [ "$result" = UPDATED ]; then
      status PLAN "Back up and replace: $target"
    else
      status PLAN "Create: $target"
    fi
    return
  fi

  backup "$target"

  mkdir -p "$(dirname "$target")"
  temp=$(mktemp "$target.tmp.XXXXXX")
  if ! cp "$source" "$temp" || ! mv -f "$temp" "$target"; then
    rm -f "$temp"
    die "Could not copy $target (backup preserved)."
  fi
  status "$result" "$target"
}

merge_json() {
  local mode=$1 target=$2
  if $DRY_RUN; then
    status PLAN "Merge managed $mode settings (back up if changed): $target"
    return
  fi

  node "$ROOT/scripts/config.mjs" "$mode" "$target" > "$WORK/config.json"
  copy_file "$WORK/config.json" "$target"
}

installer() {
  local url=$1 interpreter=$2
  shift 2
  status INSTALLING "$url"
  curl --proto '=https' --tlsv1.2 -fsSL "$url" -o "$WORK/installer"
  "$interpreter" "$WORK/installer" "$@"
  status INSTALLED "$url"
}
