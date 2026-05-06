#!/bin/sh
# phantombot installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/phantomyard/phantombot/main/install.sh | sh
#
# What it does:
#   1. Detects host OS (Linux / Darwin) and arch (x86_64 → x64, aarch64/arm64 → arm64).
#   2. Fetches the latest GitHub release tag.
#   3. Downloads the matching binary + SHA256SUMS.
#   4. Verifies the SHA256 (sha256sum on Linux, shasum -a 256 on Mac).
#   5. On Mac: clears quarantine xattrs and applies an ad-hoc codesign so
#      Gatekeeper accepts the unsigned-by-Apple binary.
#   6. Installs to ~/.local/bin/phantombot (mode 0755).
#   7. Warns if ~/.local/bin isn't on PATH.
#   8. Launches `phantombot init` to set up harness, persona, telegram, and
#      (on Linux) the systemd background service.
#
# Override the install dir with PHANTOMBOT_INSTALL_DIR=/some/path.
# Skip the init TUI launch with PHANTOMBOT_SKIP_TUI=1 (e.g. CI smoke tests).
#
# Refusal modes (intentional — bail fast):
#   - unsupported OS or arch
#   - no curl available
#   - no sha256 tool available (sha256sum / shasum)
#   - GitHub API didn't return a parseable tag
#   - SHA256 mismatch
#   - install dir not writable

set -eu

REPO="phantomyard/phantombot"
INSTALL_DIR="${PHANTOMBOT_INSTALL_DIR:-$HOME/.local/bin}"

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

# --- preflight -----------------------------------------------------------

if ! command -v curl >/dev/null 2>&1; then
  printf 'phantombot: curl not found (needed to download the release)\n' >&2
  exit 1
fi

# Pick a SHA256 tool: sha256sum on Linux, shasum -a 256 on Mac.
if command -v sha256sum >/dev/null 2>&1; then
  sha256_cmd="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  sha256_cmd="shasum -a 256"
else
  printf 'phantombot: no sha256 tool found (need sha256sum or shasum)\n' >&2
  exit 1
fi

# Mac-only: codesign + xattr are needed to satisfy Gatekeeper on
# unsigned-by-Apple binaries. Both ship with the Xcode Command Line Tools
# (and a stock macOS install has them too).
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

# --- discover latest tag -------------------------------------------------

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

# Cheap tag extraction with sed — avoids a jq dependency.
tag="$(printf '%s' "$release_json" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
if [ -z "$tag" ]; then
  printf 'phantombot: could not parse latest tag from %s\n' "$api_url" >&2
  exit 1
fi

asset="phantombot-${tag}-${platform}-${arch}"
binary_url="https://github.com/$REPO/releases/download/${tag}/${asset}"
sums_url="https://github.com/$REPO/releases/download/${tag}/SHA256SUMS"

# --- download + verify ---------------------------------------------------

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

# --- macOS Gatekeeper prep ----------------------------------------------

# On Apple Silicon, unsigned ARM64 binaries are rejected by the kernel
# unless they carry a code signature (even ad-hoc), and Gatekeeper also
# refuses anything carrying the com.apple.quarantine xattr from a
# browser/curl download. Strip xattrs and apply an ad-hoc signature so
# the user doesn't have to run this dance manually after install.
if [ "$platform" = "darwin" ]; then
  printf 'phantombot: clearing quarantine and ad-hoc codesigning (macOS)\n'
  xattr -cr "$tmp_bin"
  codesign --force --sign - "$tmp_bin" >/dev/null 2>&1
fi

# --- install -------------------------------------------------------------

# Atomic on Linux + macOS: rename(2) over the destination is safe even if
# the destination is the running binary (kernel uses inode, not path).
chmod 0755 "$tmp_bin"
mv "$tmp_bin" "$INSTALL_DIR/phantombot"
trap - EXIT INT TERM

printf 'phantombot: installed %s to %s/phantombot\n' "$tag" "$INSTALL_DIR"

# --- PATH check ----------------------------------------------------------
#
# If the install dir isn't on the user's PATH, try to fix it for them by
# appending an export line to their shell rc file. We pick the rc file
# from $SHELL (the user's login shell), not from the script's interpreter
# — the installer runs under /bin/sh regardless of what the user uses
# interactively. If $SHELL isn't one we recognise, fall back to printing
# manual instructions.

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    rc_file=""
    case "${SHELL:-}" in
      */zsh)  rc_file="$HOME/.zshrc" ;;
      */bash) rc_file="$HOME/.bashrc" ;;
    esac

    if [ -n "$rc_file" ]; then
      # Make sure the rc file exists so the grep + append below behave.
      [ -f "$rc_file" ] || touch "$rc_file"

      # Substring match: if the install dir is mentioned anywhere in the
      # rc file (export, prepend, comment) assume the user has it covered
      # and don't duplicate.
      if grep -Fq "$INSTALL_DIR" "$rc_file"; then
        printf '\nphantombot: %s is already referenced in %s.\n' "$INSTALL_DIR" "$rc_file" >&2
        printf 'open a new shell, or run this to use phantombot now:\n' >&2
        printf '  source %s\n\n' "$rc_file" >&2
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
      printf '\nphantombot: %s is not on your PATH and your shell (%s) is not auto-supported.\n' \
        "$INSTALL_DIR" "${SHELL:-unknown}" >&2
      printf 'add this to your shell profile:\n' >&2
      printf '  export PATH="%s:$PATH"\n\n' "$INSTALL_DIR" >&2
    fi
    ;;
esac

# --- launch the init wizard ---------------------------------------------

if [ -n "${PHANTOMBOT_SKIP_TUI:-}" ]; then
  exit 0
fi

# If stdin or stdout is not a TTY (e.g. when this script was piped from
# `curl … | sh`), reattach all three streams to /dev/tty before exec'ing
# the wizard. @clack/prompts checks `process.stdout.isTTY` to enable its
# interactive renderer; redirecting only stdin would leave the spinner
# and prompt output rendering against a pipe and degrade the UI.
if [ ! -t 0 ] || [ ! -t 1 ]; then
  if [ -e /dev/tty ] && [ -r /dev/tty ] && [ -w /dev/tty ]; then
    printf '\nphantombot: not a TTY (script was piped). Launching interactive setup via /dev/tty.\n\n'
    exec "$INSTALL_DIR/phantombot" init </dev/tty >/dev/tty 2>&1
  else
    printf '\nnext, run this to finish setup:\n'
    printf '  phantombot init\n\n'
    exit 0
  fi
fi

printf '\nphantombot: launching setup wizard.\n\n'
exec "$INSTALL_DIR/phantombot" init
