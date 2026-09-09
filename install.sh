#!/bin/sh
# phantombot installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/phantomyard/phantombot/main/install.sh | sh
#   ./install.sh [--dryrun]
#
# What it does:
#   1. Detects host OS (Linux / Darwin) and arch (x86_64 → x64, aarch64/arm64 → arm64).
#   2. Downloads and installs the binary to ~/.local/bin/phantombot (mode 0755) and checks PATH.
#   3. Installs background service as user (autostart on login as default, with prompt for boot).
#   4. Detects harnesses on PATH and proposes Pi install if none found.
#   5. Launches the Phantombot TUI (in sandbox mode if --dryrun).
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

# --- OS + arch detection -------------------------------------------------

uname_s="$(uname -s)"
uname_m="$(uname -m)"

case "$uname_s" in
  Linux)   platform="linux" ;;
  Darwin)  platform="darwin" ;;
  *)
    printf 'phantombot: unsupported OS %s (only Linux and Darwin are released)\n' "$uname_s" >&2
    exit 1
    ;;
esac

case "$uname_m" in
  x86_64|amd64)        arch="x64" ;;
  aarch64|arm64)       arch="arm64" ;;
  *)
    printf 'phantombot: unsupported arch %s (only x86_64 / aarch64 are released)\n' "$uname_m" >&2
    exit 1
    ;;
esac

# --- install binary ------------------------------------------------------

if [ -n "${PHANTOMBOT_DEV_BIN:-}" ]; then
  if [ "$DRYRUN" -eq 0 ]; then
    mkdir -p "$INSTALL_DIR"
    cp "$PHANTOMBOT_DEV_BIN" "$INSTALL_DIR/phantombot"
    chmod 0755 "$INSTALL_DIR/phantombot"
    printf 'phantombot: installed dev binary %s to %s/phantombot\n' "$PHANTOMBOT_DEV_BIN" "$INSTALL_DIR"
    PB_BIN="$INSTALL_DIR/phantombot"
  else
    PB_BIN="$PHANTOMBOT_DEV_BIN"
    printf 'phantombot: using dev binary %s\n' "$PB_BIN"
  fi
elif [ "$DRYRUN" -eq 0 ]; then
  # Preflight tools check
  if ! command -v curl >/dev/null 2>&1; then
    printf 'phantombot: curl not found (needed to download the release)\n' >&2
    exit 1
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    sha256_cmd="sha256sum"
  elif command -v shasum >/dev/null 2>&1; then
    sha256_cmd="shasum -a 256"
  else
    printf 'phantombot: no sha256 tool found (need sha256sum or shasum)\n' >&2
    exit 1
  fi

  if [ "$platform" = "darwin" ]; then
    if ! command -v codesign >/dev/null 2>&1; then
      printf 'phantombot: codesign not found (install Xcode Command Line Tools: xcode-select --install)\n' >&2
      exit 1
    fi
    if ! command -v xattr >/dev/null 2>&1; then
      printf 'phantombot: xattr not found (install Xcode Command Line Tools: xcode-select --install)\n' >&2
      exit 1
    fi
  fi

  mkdir -p "$INSTALL_DIR"
  if [ ! -w "$INSTALL_DIR" ]; then
    printf 'phantombot: install dir %s is not writable\n' "$INSTALL_DIR" >&2
    exit 1
  fi

  # Discover latest tag
  api_url="https://api.github.com/repos/$REPO/releases/latest"
  auth_header=""
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    auth_header="Authorization: Bearer $GITHUB_TOKEN"
  fi

  if [ -n "$auth_header" ]; then
    release_json="$(curl -fsSL -H "$auth_header" "$api_url")"
  else
    release_json="$(curl -fsSL "$api_url")"
  fi

  tag="$(printf '%s' "$release_json" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
  if [ -z "$tag" ]; then
    printf 'phantombot: could not parse latest tag from %s\n' "$api_url" >&2
    exit 1
  fi

  asset="phantombot-${tag}-${platform}-${arch}"
  binary_url="https://github.com/$REPO/releases/download/${tag}/${asset}"
  sums_url="https://github.com/$REPO/releases/download/${tag}/SHA256SUMS"

  tmp_bin="$(mktemp "${TMPDIR:-/tmp}/phantombot.XXXXXX")"
  trap 'rm -f "$tmp_bin"' EXIT INT TERM

  printf 'phantombot: downloading %s\n' "$asset"
  curl -fsSL -o "$tmp_bin" "$binary_url"

  printf 'phantombot: verifying SHA256\n'
  expected="$(curl -fsSL "$sums_url" | grep " $asset\$" | awk '{print $1}')"
  if [ -z "$expected" ]; then
    printf 'phantombot: SHA256SUMS has no entry for %s\n' "$asset" >&2
    exit 1
  fi
  actual="$($sha256_cmd "$tmp_bin" | awk '{print $1}')"
  if [ "$expected" != "$actual" ]; then
    printf 'phantombot: SHA256 mismatch (expected %s, got %s) — refusing to install\n' "$expected" "$actual" >&2
    exit 1
  fi

  if [ "$platform" = "darwin" ]; then
    printf 'phantombot: clearing quarantine and ad-hoc codesigning (macOS)\n'
    xattr -cr "$tmp_bin"
    codesign --force --sign - "$tmp_bin" >/dev/null 2>&1
  fi

  chmod 0755 "$tmp_bin"
  mv "$tmp_bin" "$INSTALL_DIR/phantombot"
  trap - EXIT INT TERM

  printf 'phantombot: installed %s to %s/phantombot\n' "$tag" "$INSTALL_DIR"
  PB_BIN="$INSTALL_DIR/phantombot"
else
  printf 'phantombot: [dryrun] skipping binary download and installation\n'
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

# --- PATH check ----------------------------------------------------------

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    rc_file=""
    case "${SHELL:-}" in
      */zsh)  rc_file="$HOME/.zshrc" ;;
      */bash) rc_file="$HOME/.bashrc" ;;
    esac

    if [ -n "$rc_file" ]; then
      if [ "$DRYRUN" -eq 0 ]; then
        [ -f "$rc_file" ] || touch "$rc_file"
        if grep -Fq "$INSTALL_DIR" "$rc_file"; then
          printf '\nphantombot: %s is already referenced in %s.\n' "$INSTALL_DIR" "$rc_file" >&2
        else
          {
            printf '\n# added by phantombot installer\n'
            printf 'export PATH="%s:$PATH"\n' "$INSTALL_DIR"
          } >> "$rc_file"
          printf '\nphantombot: added %s to PATH in %s.\n' "$INSTALL_DIR" "$rc_file" >&2
          printf 'open a new shell, or run this to use phantombot now:\n' >&2
          printf '  source %s\n\n' "$rc_file" >&2
        fi
      else
        printf 'phantombot: [dryrun] would add %s to PATH in %s\n' "$INSTALL_DIR" "$rc_file"
      fi
    else
      printf '\nphantombot: %s is not on your PATH and your shell (%s) is not auto-supported.\n' \
        "$INSTALL_DIR" "${SHELL:-unknown}" >&2
      printf 'add this to your shell profile:\n' >&2
      printf '  export PATH="%s:$PATH"\n\n' "$INSTALL_DIR" >&2
    fi
    ;;
esac

can_open_dev_tty() {
  ( exec 3</dev/tty ) 2>/dev/null
}

# --- autostart service installation --------------------------------------

if [ "$DRYRUN" -eq 0 ]; then
  if [ ! -t 0 ] || [ ! -t 1 ]; then
    if can_open_dev_tty; then
      $PB_BIN install </dev/tty >/dev/tty 2>&1 || true
    else
      $PB_BIN install || true
    fi
  else
    $PB_BIN install || true
  fi
else
  printf 'phantombot: [dryrun] skipping background service installation\n'
fi

# --- harness check -------------------------------------------------------

if [ "$DRYRUN" -eq 0 ]; then
  if [ ! -t 0 ] || [ ! -t 1 ]; then
    if can_open_dev_tty; then
      $PB_BIN harness --check </dev/tty >/dev/tty 2>&1 || exit 0
    else
      $PB_BIN harness --check || exit 0
    fi
  else
    $PB_BIN harness --check || exit 0
  fi
else
  if [ ! -t 0 ] || [ ! -t 1 ]; then
    if can_open_dev_tty; then
      $PB_BIN harness --check --dryrun </dev/tty >/dev/tty 2>&1 || exit 0
    else
      $PB_BIN harness --check --dryrun || exit 0
    fi
  else
    $PB_BIN harness --check --dryrun || exit 0
  fi
fi

# --- launch TUI ----------------------------------------------------------

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
  printf '\nphantombot: launching TUI in sandbox mode.\n\n'
else
  printf '\nphantombot: launching TUI.\n\n'
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
