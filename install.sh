#!/bin/sh
# phantombot installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/phantomyard/phantombot/main/install.sh | sh
#   ./install.sh [--dryrun]
#
# Override the install dir with PHANTOMBOT_INSTALL_DIR=/some/path.
# Skip the TUI launch with PHANTOMBOT_SKIP_TUI=1 (e.g. CI smoke tests).
# Run without making changes with --dryrun (or PHANTOMBOT_DRY_RUN=1).

set -eu

REPO="phantomyard/phantombot"
INSTALL_DIR="${PHANTOMBOT_INSTALL_DIR:-$HOME/.local/bin}"

# --- flags ---------------------------------------------------------------

DRYRUN=0
for arg in "$@"; do
  case "$arg" in
    --dryrun|--dry-run|-d)
      DRYRUN=1
      ;;
  esac
done

if [ -n "${PHANTOMBOT_DRY_RUN:-}" ] || [ -n "${PHANTOMBOT_DRYRUN:-}" ]; then
  DRYRUN=1
fi

can_open_dev_tty() {
  ( exec 3</dev/tty ) 2>/dev/null
}

# --- 1. Clear Screen & Presentation Animation ----------------------------

if [ -t 1 ]; then
  printf '\033[2J\033[3J\033[H'
  CHECK="$(printf '\033[32m✓\033[0m')"
  CROSS="$(printf '\033[31m✗\033[0m')"
else
  CHECK="✓"
  CROSS="✗"
fi

render_intro() {
  if [ -t 1 ]; then
    c24="\033[38;5;24m"
    c26="\033[38;5;26m"
    c33="\033[38;5;33m"
    c39="\033[38;5;39m"
    c45="\033[38;5;45m"
    c51="\033[38;5;51m"
    c87="\033[38;5;87m"
    c123="\033[38;5;123m"
    c159="\033[38;5;159m"
    c231="\033[38;5;231m"

    d236="\033[38;5;236m"
    d240="\033[38;5;240m"
    d245="\033[38;5;245m"

    w0="\033[38;5;231m"
    reset="\033[0m"
    bold="\033[1m"

    printf '\n'
    printf "                     %b▄▄▄▄████████▄▄▄▄%b\n" "$c24" "$reset"
    sleep 0.015 2>/dev/null || true
    printf "                 %b▄▄███▀▀▀        ▀▀▀███▄▄%b\n" "$c26" "$reset"
    sleep 0.015 2>/dev/null || true
    printf "              %b▄███▀     %b▄▄▄██████▄▄▄%b     %b▀███▄%b\n" "$c33" "$c39" "$reset" "$c33" "$reset"
    sleep 0.015 2>/dev/null || true
    printf "            %b▄██▀     %b▄███▀▀      ▀▀███▄%b     %b▀██▄%b\n" "$c39" "$c45" "$reset" "$c39" "$reset"
    sleep 0.015 2>/dev/null || true
    printf "           %b▄██▀     %b███    %b▄▄████▄▄%b    %b███%b     %b▀██▄%b\n" "$c45" "$c51" "$d236" "$reset" "$c51" "$reset" "$c45" "$reset"
    sleep 0.015 2>/dev/null || true
    printf "          %b███      %b███    %b▄██▀    ▀██▄%b    %b███%b      %b███%b\n" "$c51" "$c87" "$d240" "$reset" "$c87" "$reset" "$c51" "$reset"
    sleep 0.015 2>/dev/null || true
    printf "          %b███      %b███    %b██        ██%b    %b███%b      %b███%b\n" "$c87" "$c123" "$d245" "$reset" "$c123" "$reset" "$c87" "$reset"
    sleep 0.015 2>/dev/null || true
    printf "          %b███      %b███    %b██ %b╺%b━%b━%b━%b╸%b●%b╺%b━%b━%b━%b╸ %b██%b    %b███%b      %b███%b\n" "$c123" "$c159" "$d245" "$c33" "$c39" "$c45" "$c51" "$c87" "$w0" "$c87" "$c51" "$c45" "$c39" "$c33" "$d245" "$reset" "$c159" "$reset" "$c123" "$reset"
    sleep 0.015 2>/dev/null || true
    printf "          %b███      %b███    %b██        ██%b    %b███%b      %b███%b\n" "$c87" "$c123" "$d245" "$reset" "$c123" "$reset" "$c87" "$reset"
    sleep 0.015 2>/dev/null || true
    printf "          %b███      %b███    %b▀██▄    ▄██▀%b    %b███%b      %b███%b\n" "$c51" "$c87" "$d240" "$reset" "$c87" "$reset" "$c51" "$reset"
    sleep 0.015 2>/dev/null || true
    printf "           %b▀██▄     %b███    %b▀▀████▀▀%b    %b███%b     %b▄██▀%b\n" "$c45" "$c51" "$d236" "$reset" "$c51" "$reset" "$c45" "$reset"
    sleep 0.015 2>/dev/null || true
    printf "            %b▀██▄     %b▀███▄▄      ▄▄███▀%b     %b▄██▀%b\n" "$c39" "$c45" "$reset" "$c39" "$reset"
    sleep 0.015 2>/dev/null || true
    printf "              %b▀███▄     %b▀▀▀██████▀▀▀%b     %b▄███▀%b\n" "$c33" "$c39" "$reset" "$c33" "$reset"
    sleep 0.015 2>/dev/null || true
    printf "                 %b▀▀███▄▄▄        ▄▄▄███▀▀%b\n" "$c26" "$reset"
    sleep 0.015 2>/dev/null || true
    printf "                     %b▀▀▀▀████████▀▀▀▀%b\n\n" "$c24" "$reset"
    sleep 0.02 2>/dev/null || true

    c21="\033[38;5;21m"
    c27="\033[38;5;27m"

    printf "  %b█████▄ %b██  ██ %b▄████▄ %b███  ██ %b███████ %b▄████▄ %b███▄███  %b█████▄ %b▄████▄ %b███████%b\n" \
      "$c39" "$c45" "$c51" "$c51" "$c87" "$c87" "$c123" "$c123" "$c159" "$c231" "$reset"
    sleep 0.015 2>/dev/null || true

    printf "  %b██▄▄██ %b██  ██ %b██▄▄██ %b████ ██ %b  ██   %b██  ██ %b██▀█▀██  %b██▄▄██ %b██  ██ %b  ██   %b\n" \
      "$c33" "$c39" "$c45" "$c45" "$c51" "$c51" "$c87" "$c87" "$c123" "$c159" "$reset"
    sleep 0.015 2>/dev/null || true

    printf "  %b██▀▀▀  %b██████ %b██▀▀██ %b██ ████ %b  ██   %b██  ██ %b██ ▀ ██  %b██▀▀██ %b██  ██ %b  ██   %b\n" \
      "$c27" "$c33" "$c39" "$c39" "$c45" "$c45" "$c51" "$c51" "$c87" "$c123" "$reset"
    sleep 0.015 2>/dev/null || true

    printf "  %b██     %b██  ██ %b██  ██ %b██  ███ %b  ██   %b▀████▀ %b██   ██  %b█████▀ %b▀████▀ %b  ██   %b\n\n" \
      "$c21" "$c27" "$c33" "$c33" "$c39" "$c39" "$c45" "$c45" "$c51" "$c87" "$reset"
    sleep 0.02 2>/dev/null || true

    printf "    %b◈%b  %b%bLearns your world, defends your runtime, never wastes a token.%b  %b◈%b\n\n" \
      "$c33" "$reset" "$c123" "$bold" "$reset" "$c33" "$reset"
  else
    printf '\nPhantombot Installer\nLearns your world, defends your runtime, never wastes a token.\n\n'
  fi
}

render_intro

# --- 2. Welcome & Confirmation -------------------------------------------

welcome_choice="y"
if [ -t 0 ]; then
  printf 'Welcome! Do you want to install Phantombot? [Y/n] '
  read -r welcome_choice || welcome_choice="y"
elif can_open_dev_tty; then
  printf 'Welcome! Do you want to install Phantombot? [Y/n] '
  read -r welcome_choice </dev/tty || welcome_choice="y"
fi

case "$welcome_choice" in
  ""|[yY]|[yY][eE][sS])
    ;;
  *)
    printf '\nInstallation cancelled.\n'
    exit 0
    ;;
esac

printf '\nInstalling Phantombot...\n\n'

# --- 3. Inspecting System ------------------------------------------------

printf 'Inspecting System.....'

uname_s="$(uname -s)"
uname_m="$(uname -m)"

case "$uname_s" in
  Linux)   platform="linux" ;;
  Darwin)  platform="darwin" ;;
  *)
    printf ' failed\n'
    printf 'phantombot: unsupported OS %s (only Linux and Darwin are released)\n' "$uname_s" >&2
    exit 1
    ;;
esac

case "$uname_m" in
  x86_64|amd64)        arch="x64" ;;
  aarch64|arm64)       arch="arm64" ;;
  *)
    printf ' failed\n'
    printf 'phantombot: unsupported arch %s (only x86_64 / aarch64 are released)\n' "$uname_m" >&2
    exit 1
    ;;
esac

if [ -z "${PHANTOMBOT_DEV_BIN:-}" ] && [ "$DRYRUN" -eq 0 ]; then
  if ! command -v curl >/dev/null 2>&1; then
    printf ' failed\n'
    printf 'phantombot: curl not found (needed to download the release)\n' >&2
    exit 1
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    sha256_cmd="sha256sum"
  elif command -v shasum >/dev/null 2>&1; then
    sha256_cmd="shasum -a 256"
  else
    printf ' failed\n'
    printf 'phantombot: no sha256 tool found (need sha256sum or shasum)\n' >&2
    exit 1
  fi

  if [ "$platform" = "darwin" ]; then
    if ! command -v codesign >/dev/null 2>&1; then
      printf ' failed\n'
      printf 'phantombot: codesign not found (install Xcode Command Line Tools: xcode-select --install)\n' >&2
      exit 1
    fi
    if ! command -v xattr >/dev/null 2>&1; then
      printf ' failed\n'
      printf 'phantombot: xattr not found (install Xcode Command Line Tools: xcode-select --install)\n' >&2
      exit 1
    fi
  fi
fi

if [ "$DRYRUN" -eq 0 ]; then
  mkdir -p "$INSTALL_DIR" 2>/dev/null || true
  if [ ! -w "$INSTALL_DIR" ] && [ -z "${PHANTOMBOT_DEV_BIN:-}" ]; then
    printf ' failed\n'
    printf 'phantombot: install dir %s is not writable\n' "$INSTALL_DIR" >&2
    exit 1
  fi
fi

printf '%s\n' "$CHECK"

# --- 4. Downloading Binary -----------------------------------------------

printf 'Downloading Binary....'

tmp_bin=""
if [ -n "${PHANTOMBOT_DEV_BIN:-}" ]; then
  # Dev binary provided — nothing to download
  :
elif [ "$DRYRUN" -eq 0 ]; then
  api_url="https://api.github.com/repos/$REPO/releases/latest"
  auth_header=""
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    auth_header="Authorization: Bearer $GITHUB_TOKEN"
  fi

  if [ -n "$auth_header" ]; then
    release_json="$(curl -fsSL -H "$auth_header" "$api_url" 2>/dev/null || true)"
  else
    release_json="$(curl -fsSL "$api_url" 2>/dev/null || true)"
  fi

  tag="$(printf '%s' "$release_json" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
  if [ -z "$tag" ]; then
    printf ' failed\n'
    printf 'phantombot: could not parse latest tag from %s\n' "$api_url" >&2
    exit 1
  fi

  asset="phantombot-${tag}-${platform}-${arch}"
  binary_url="https://github.com/$REPO/releases/download/${tag}/${asset}"
  sums_url="https://github.com/$REPO/releases/download/${tag}/SHA256SUMS"

  tmp_bin="$(mktemp "${TMPDIR:-/tmp}/phantombot.XXXXXX")"
  trap 'rm -f "$tmp_bin"' EXIT INT TERM

  if ! curl -fsSL -o "$tmp_bin" "$binary_url" 2>/dev/null; then
    printf ' failed\n'
    printf 'phantombot: failed to download %s\n' "$binary_url" >&2
    exit 1
  fi

  expected="$(curl -fsSL "$sums_url" 2>/dev/null | grep " $asset\$" | awk '{print $1}' || true)"
  if [ -z "$expected" ]; then
    printf ' failed\n'
    printf 'phantombot: SHA256SUMS has no entry for %s\n' "$asset" >&2
    exit 1
  fi
  actual="$($sha256_cmd "$tmp_bin" | awk '{print $1}')"
  if [ "$expected" != "$actual" ]; then
    printf ' failed\n'
    printf 'phantombot: SHA256 mismatch (expected %s, got %s) — refusing to install\n' "$expected" "$actual" >&2
    exit 1
  fi
fi

printf '%s\n' "$CHECK"

# --- 5. Installing Now ---------------------------------------------------

printf 'Installing Now........'

if [ -n "${PHANTOMBOT_DEV_BIN:-}" ]; then
  if [ "$DRYRUN" -eq 0 ]; then
    mkdir -p "$INSTALL_DIR"
    cp "$PHANTOMBOT_DEV_BIN" "$INSTALL_DIR/phantombot"
    chmod 0755 "$INSTALL_DIR/phantombot"
    PB_BIN="$INSTALL_DIR/phantombot"
  else
    PB_BIN="$PHANTOMBOT_DEV_BIN"
  fi
elif [ "$DRYRUN" -eq 0 ]; then
  if [ "$platform" = "darwin" ]; then
    xattr -cr "$tmp_bin" >/dev/null 2>&1 || true
    codesign --force --sign - "$tmp_bin" >/dev/null 2>&1 || true
  fi

  chmod 0755 "$tmp_bin"
  mv "$tmp_bin" "$INSTALL_DIR/phantombot"
  trap - EXIT INT TERM
  PB_BIN="$INSTALL_DIR/phantombot"
else
  if [ -x "./dist/phantombot" ]; then
    PB_BIN="./dist/phantombot"
  elif command -v bun >/dev/null 2>&1 && [ -f "src/index.ts" ]; then
    PB_BIN="bun src/index.ts"
  elif [ -x "$INSTALL_DIR/phantombot" ]; then
    PB_BIN="$INSTALL_DIR/phantombot"
  elif command -v phantombot >/dev/null 2>&1; then
    PB_BIN="$(command -v phantombot)"
  else
    PB_BIN="$INSTALL_DIR/phantombot"
  fi
fi

# PATH configuration
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    rc_file=""
    case "${SHELL:-}" in
      */zsh)  rc_file="$HOME/.zshrc" ;;
      */bash) rc_file="$HOME/.bashrc" ;;
      *)
        if [ -n "${BASH_VERSION:-}" ] || [ -f "$HOME/.bashrc" ]; then
          rc_file="$HOME/.bashrc"
        elif [ -f "$HOME/.profile" ]; then
          rc_file="$HOME/.profile"
        elif [ -f "$HOME/.zshrc" ]; then
          rc_file="$HOME/.zshrc"
        fi
        ;;
    esac

    if [ -n "$rc_file" ] && [ "$DRYRUN" -eq 0 ]; then
      [ -f "$rc_file" ] || touch "$rc_file"
      if ! grep -Fq "$INSTALL_DIR" "$rc_file"; then
        {
          printf '\n# added by phantombot installer\n'
          printf 'export PATH="%s:$PATH"\n' "$INSTALL_DIR"
        } >> "$rc_file"
      fi
    fi
    ;;
esac

printf '%s\n' "$CHECK"

# --- 6. Verifying --------------------------------------------------------

printf 'Verifying.............'

# A real check, not a decorative one: the installed binary must be executable
# AND must run. A truncated download, a wrong-arch asset or a broken codesign
# all produce a file that exists and fails here — printing a green tick for
# any of those is worse than not checking at all.
if [ "$DRYRUN" -eq 1 ]; then
  printf '%s\n' "$CHECK"
elif [ -z "${PB_BIN:-}" ] || [ ! -x "$PB_BIN" ]; then
  printf '%s\n' "$CROSS"
  printf 'phantombot: %s is missing or not executable\n' "${PB_BIN:-<unset>}" >&2
  exit 1
elif ! verify_out="$("$PB_BIN" --version 2>&1)"; then
  printf '%s\n' "$CROSS"
  printf 'phantombot: %s --version failed:\n%s\n' "$PB_BIN" "$verify_out" >&2
  exit 1
else
  printf '%s %s\n' "$CHECK" "$verify_out"
fi

# --- 7. Autostart Service Installation -----------------------------------

if [ "$DRYRUN" -eq 0 ]; then
  if [ "$platform" != "darwin" ]; then
    boot_choice="n"
    if [ -t 0 ]; then
      printf '\nDo you want to start at boot? [y/N] '
      read -r boot_choice || boot_choice="n"
    elif can_open_dev_tty; then
      printf '\nDo you want to start at boot? [y/N] '
      read -r boot_choice </dev/tty || boot_choice="n"
    fi

    case "$boot_choice" in
      [yY]|[yY][eE][sS])
        if command -v loginctl >/dev/null 2>&1; then
          if ! loginctl enable-linger "$USER" 2>/dev/null; then
            if [ -t 0 ] && [ -t 1 ]; then
              sudo loginctl enable-linger "$USER" || true
            elif can_open_dev_tty; then
              sudo loginctl enable-linger "$USER" </dev/tty >/dev/tty || true
            fi
          fi
        fi
        ;;
      *)
        ;;
    esac
  fi

  if [ -n "${PB_BIN:-}" ] && [ -x "$PB_BIN" ]; then
    printf '\nRegistering service....'
    # `install` registers the platform service (systemd --user unit, launchd
    # LaunchAgent, or Task Scheduler task set) AND starts it. Its exit status is
    # the only signal that the agent will actually come back after a reboot, so
    # a failure here is reported rather than discarded — a silently skipped
    # service install looks identical to a successful one until the next boot.
    install_rc=0
    if [ -t 0 ] && [ -t 1 ]; then
      install_out="$($PB_BIN install 2>&1)" || install_rc=$?
    elif can_open_dev_tty; then
      # Interactive path: `install` may prompt, so it keeps the terminal and we
      # only capture the status.
      printf '\n\n'
      $PB_BIN install </dev/tty >/dev/tty 2>&1 || install_rc=$?
      install_out=""
    else
      install_out="$($PB_BIN install 2>&1)" || install_rc=$?
    fi

    if [ "$install_rc" -eq 0 ]; then
      printf '%s\n' "$CHECK"
    else
      printf '%s\n' "$CROSS"
      printf 'phantombot: service install failed (exit %s).\n' "$install_rc" >&2
      [ -n "${install_out:-}" ] && printf '%s\n' "$install_out" >&2
      printf 'phantombot: the binary is installed and usable; run `%s install` to retry the service.\n' "$PB_BIN" >&2
      SERVICE_FAILED=1
    fi
  fi
fi

if [ "${SERVICE_FAILED:-0}" -eq 1 ]; then
  printf '\nPhantombot is installed, but the background service is not — see the error above.\n'
else
  printf '\nInstallation completed successfully.\n'
fi

# --- 8. Launch TUI -------------------------------------------------------

if [ -n "${PHANTOMBOT_SKIP_TUI:-}" ]; then
  exit 0
fi

if [ "$DRYRUN" -eq 1 ]; then
  SANDBOX_DIR="${PHANTOMBOT_SANDBOX_DIR:-$HOME/.phantombot-sandbox}"
  mkdir -p "$SANDBOX_DIR/config" "$SANDBOX_DIR/data" "$SANDBOX_DIR/state"
  export PHANTOMBOT_SANDBOX=1
  export XDG_CONFIG_HOME="$SANDBOX_DIR/config"
  export XDG_DATA_HOME="$SANDBOX_DIR/data"
  export XDG_STATE_HOME="$SANDBOX_DIR/state"
  export PHANTOMBOT_CONFIG="$SANDBOX_DIR/config/phantombot/config.toml"
  export PHANTOMBOT_PERSONAS_DIR="$SANDBOX_DIR/data/phantombot/personas"
fi

if [ ! -t 0 ] || [ ! -t 1 ]; then
  if can_open_dev_tty; then
    if [ "$platform" = "darwin" ]; then
      if command -v script >/dev/null 2>&1; then
        exec script -q /dev/null $PB_BIN </dev/tty
      else
        printf 'next, run phantombot in your terminal to start.\n'
        exit 0
      fi
    else
      exec $PB_BIN </dev/tty >/dev/tty 2>&1
    fi
  else
    printf 'next, run phantombot in your terminal to start.\n'
    exit 0
  fi
fi

exec $PB_BIN
