#!/usr/bin/env bash
# Phase 1 regression guard: prove the Matrix native crypto addon is embedded in a
# `bun build --compile` binary and loads with NO node_modules and NO sibling
# .node — i.e. a genuine single-file binary. Guards against a future bun/addon
# change breaking the static-require embed path (see nativeCrypto.ts).
set -euo pipefail

export PATH="$HOME/.bun/bin:$PATH"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

# Map the host arch to its variant so the default invocation builds a binary
# this host can actually exec. Defaulting to a fixed arch cross-compiles a
# non-runnable binary and the guard fails before it ever tests crypto.
case "$(uname -m)" in
  x86_64|amd64)  HOST_VARIANT="linux-x64-gnu" ;;
  aarch64|arm64) HOST_VARIANT="linux-arm64-gnu" ;;
  *)             HOST_VARIANT="" ;;
esac

if [ -n "${1:-}" ]; then
  VARIANT="$1"
elif [ -n "$HOST_VARIANT" ]; then
  VARIANT="$HOST_VARIANT"
else
  echo "[smoke] unsupported host arch $(uname -m); pass an explicit variant (linux-x64-gnu|linux-arm64-gnu)"; exit 2
fi

case "$VARIANT" in
  linux-arm64-gnu) TARGET=bun-linux-arm64 ;;
  linux-x64-gnu)   TARGET=bun-linux-x64-baseline ;;
  *) echo "[smoke] unknown variant $VARIANT"; exit 2 ;;
esac

# Reject cross-arch builds before compiling — the resulting binary can't run here.
if [ -n "$HOST_VARIANT" ] && [ "$VARIANT" != "$HOST_VARIANT" ]; then
  echo "[smoke] refusing to cross-compile: variant=$VARIANT but host is $(uname -m) ($HOST_VARIANT); binary would not be runnable here."
  exit 2
fi

OUT="$(mktemp -d /tmp/pb-smoke.XXXXXX)"
trap 'rm -rf "$OUT"' EXIT

echo "[smoke] compiling single binary ($TARGET) -> $OUT/phantombot-smoke"
bun build --compile --target="$TARGET" ./scripts/smoke-native-crypto.ts --outfile "$OUT/phantombot-smoke"

echo "[smoke] isolated dir contents (binary ONLY — no node_modules, no .node):"
ls -la "$OUT"

# The addon SIGABRTs on teardown (see smoke-native-crypto.ts), so judge by the
# PASS line, not the exit code. Run from / to rule out any cwd-relative loading.
OUTPUT="$( cd / && "$OUT/phantombot-smoke" 2>&1 || true )"
echo "$OUTPUT"
if grep -q "\[smoke\] PASS" <<<"$OUTPUT"; then
  echo "[smoke] RESULT: single-binary native crypto WORKS — PASS"
else
  echo "[smoke] RESULT: FAIL — addon did not load from the embedded binary"
  exit 1
fi
