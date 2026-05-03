#!/bin/sh
# phantombot installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/phantomyard/phantombot/main/install.sh | sh
#
# What it does:
#   1. Detects host arch (x86_64 → x64, aarch64 → arm64).
#   2. Fetches the latest GitHub release tag.
#   3. Downloads the matching binary + SHA256SUMS.
#   4. Verifies the SHA256.
#   5. Installs to ~/.local/bin/phantombot (mode 0755).
#   6. Warns if ~/.local/bin isn't on PATH.
#   7. Launches `phantombot persona` to set up the first persona.
#
# Override the install dir with PHANTOMBOT_INSTALL_DIR=/some/path.
# Skip the persona TUI launch with PHANTOMBOT_SKIP_TUI=1 (e.g. CI smoke tests).
#
# Refusal modes (intentional — bail fast):
#   - unsupported arch
#   - no curl available
#   - GitHub API didn't return a parseable tag
#   - SHA256 mismatch
#   - install dir not writable

set -eu

REPO="phantomyard/phantombot"
INSTALL_DIR="${PHANTOMBOT_INSTALL_DIR:-$HOME/.local/bin}"

# --- arch detection ------------------------------------------------------

uname_m="$(uname -m)"
case "$uname_m" in
  x86_64|amd64)        arch="x64" ;;
  aarch64|arm64)       arch="arm64" ;;
  *)
    printf 'phantombot: unsupported arch %s (only linux x86_64 / aarch64 are released)\n' "$uname_m" >&2
    exit 1
    ;;
esac

# --- preflight -----------------------------------------------------------

if ! command -v curl >/dev/null 2>&1; then
  printf 'phantombot: curl not found (needed to download the release)\n' >&2
  exit 1
fi
if ! command -v sha256sum >/dev/null 2>&1; then
  printf 'phantombot: sha256sum not found (needed to verify the download)\n' >&2
  exit 1
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

asset="phantombot-${tag}-linux-${arch}"
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
actual="$(sha256sum "$tmp_bin" | awk '{print $1}')"
if [ "$expected" != "$actual" ]; then
  printf 'phantombot: SHA256 mismatch (expected %s, got %s) — refusing to install\n' "$expected" "$actual" >&2
  exit 1
fi

# --- install -------------------------------------------------------------

# Atomic on Linux: rename(2) over the destination is safe even if the
# destination is the running binary (kernel uses inode, not path).
chmod 0755 "$tmp_bin"
mv "$tmp_bin" "$INSTALL_DIR/phantombot"
trap - EXIT INT TERM

printf 'phantombot: installed %s to %s/phantombot\n' "$tag" "$INSTALL_DIR"

# --- PATH check ----------------------------------------------------------

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    printf '\nphantombot: %s is not on your PATH.\n' "$INSTALL_DIR" >&2
    printf 'add this to your shell profile (~/.bashrc or ~/.zshrc):\n' >&2
    printf '  export PATH="%s:$PATH"\n' "$INSTALL_DIR" >&2
    printf '\nthen re-open your shell, or for this session:\n' >&2
    printf '  export PATH="%s:$PATH"\n\n' "$INSTALL_DIR" >&2
    ;;
esac

# --- launch the persona TUI ---------------------------------------------

if [ -n "${PHANTOMBOT_SKIP_TUI:-}" ]; then
  exit 0
fi

# If stdin is not a TTY (e.g. piped from `curl … | sh`), the @clack
# prompts will misbehave. Detect and print the next-step hint instead.
if [ ! -t 0 ] || [ ! -t 1 ]; then
  printf '\nphantombot: not a TTY (script was piped). Run this next to set up your first persona:\n' >&2
  printf '  phantombot persona\n\n' >&2
  exit 0
fi

printf '\nphantombot: launching persona TUI to set up your first persona.\n\n'
exec "$INSTALL_DIR/phantombot" persona
