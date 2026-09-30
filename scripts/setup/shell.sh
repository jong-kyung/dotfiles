shell_stage() {
  if $DRY_RUN; then
    log 'shell: Vite+ Node/pnpm, Bun, Rust, Oh My Zsh, zsh-autosuggestions (missing only)'
    copy_file "$ROOT/zsh/zshrc" "$HOME/.zshrc"
    return
  fi

  need git
  if ! has bun; then
    BUN_INSTALL="$HOME/.bun" SHELL=/bin/sh installer https://bun.sh/install /bin/bash
  fi
  if ! has vp; then
    export VP_HOME="$HOME/.vite-plus" VP_SELF_SETUP_NO_MODIFY_PATH=1
    export VP_NODE_MANAGER=yes VP_NPM_MANAGER=yes VP_PNPM_MANAGER=yes VP_BUN_MANAGER=no
    installer https://vite.plus /bin/bash
  fi

  need vp
  # Keep existing runtimes. A missing environment gets the current Node LTS.
  if ! vp env which node >/dev/null 2>&1; then
    vp env install lts
    vp env default lts
  fi
  if ! vp env which pnpm >/dev/null 2>&1; then
    vp env install pnpm@latest
  fi

  if ! has rustup; then
    installer https://sh.rustup.rs /bin/sh -y --no-modify-path --default-toolchain stable
  fi
  if ! rustup show active-toolchain >/dev/null 2>&1; then
    rustup toolchain install stable
    rustup default stable
  fi

  if [ ! -e "$HOME/.oh-my-zsh" ]; then
    # Keep the installer's starter .zshrc in scratch space; copy_file owns the real one.
    ZSH="$HOME/.oh-my-zsh" ZDOTDIR="$WORK/omz" installer https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh /bin/sh --unattended
  fi
  [ -f "$HOME/.oh-my-zsh/oh-my-zsh.sh" ] || die 'Existing ~/.oh-my-zsh is incomplete; resolve it before retrying.'

  local plugin="$HOME/.oh-my-zsh/custom/plugins/zsh-autosuggestions"
  if [ ! -e "$plugin" ]; then
    git clone --depth 1 https://github.com/zsh-users/zsh-autosuggestions.git "$plugin"
  fi
  [ -f "$plugin/zsh-autosuggestions.plugin.zsh" ] || die "Incomplete plugin: $plugin"

  copy_file "$ROOT/zsh/zshrc" "$HOME/.zshrc"
  vp --version
  vp env current
  bun --version
  rustc --version
}
