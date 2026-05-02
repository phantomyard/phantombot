#!/bin/bash
# Fake gemini CLI used by tests/harnesses-gemini.test.ts.
#
# Mirrors the surface of the real google-gemini/gemini-cli that the
# GeminiHarness invokes:
#   gemini -p <user_message> -o text -y [-m <model>]
#
# Modes (set via FAKE_GEMINI_MODE):
#   normal    — read stdin, echo "<reply prefix>" + last line of stdin + " | " + prompt arg, exit 0
#   error     — print "auth failed" to stderr, exit 1
#   notfound  — exit 127 (simulates "command not found"-ish)
#   hang      — sleep forever (timeout test)
#   echo-args — print all argv joined with " | " on stdout, exit 0 (arg-shape test)
#
# Note: the real gemini -p reads stdin and appends the -p value. For
# the normal-mode reply we synthesize something deterministic so tests
# can assert on the output without needing a real model.

mode="${FAKE_GEMINI_MODE:-normal}"

# Find the -p value in argv (it's the value right after a "-p" arg).
prompt=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-p" ]; then
    prompt="$a"
  fi
  prev="$a"
done

# Last non-empty line of stdin, used by normal mode to confirm we
# actually consumed stdin (not just the -p arg).
last_stdin_line=""
while IFS= read -r line; do
  if [ -n "$line" ]; then
    last_stdin_line="$line"
  fi
done

case "$mode" in
  normal)
    printf 'GEMINI_REPLY: stdin=%s prompt=%s\n' "$last_stdin_line" "$prompt"
    exit 0
    ;;
  error)
    echo "auth failed" >&2
    exit 1
    ;;
  notfound)
    exit 127
    ;;
  hang)
    exec sleep 3600
    ;;
  echo-args)
    # Joined argv on stdout for the arg-shape assertion.
    IFS=' | '
    printf '%s' "$*"
    exit 0
    ;;
  *)
    echo "fake-gemini.sh: unknown FAKE_GEMINI_MODE=$mode" >&2
    exit 2
    ;;
esac
