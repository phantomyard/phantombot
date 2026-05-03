#!/bin/bash
# Fake gemini CLI used by tests/harnesses-gemini.test.ts.
#
# Mirrors the surface of the real google-gemini/gemini-cli that the
# GeminiHarness invokes:
#   gemini -p <user_message> -o stream-json -y [-m <model>]
#
# Modes (set via FAKE_GEMINI_MODE):
#   normal    — emit a fake stream-json transcript: init → tool_use →
#               tool_result → assistant text deltas (whose content
#               echoes the prompt + last stdin line so tests can
#               verify stdin/argv plumbing) → result. Exit 0.
#   error     — print "auth failed" to stderr, exit 1
#   notfound  — exit 127 (simulates "command not found"-ish)
#   hang      — sleep forever (timeout test)
#   echo-args — print all argv joined with " | " on stdout, exit 0 (arg-shape test)

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

# JSON-escape a string for embedding inside a JSON-string literal.
# Handles backslash, double-quote, and newline — enough for the
# deterministic test payloads below.
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  printf '%s' "$s"
}

case "$mode" in
  normal)
    printf '{"type":"init","session_id":"fake","model":"fake-model"}\n'
    printf '{"type":"tool_use","tool_name":"echo","tool_id":"t1","parameters":{}}\n'
    printf '{"type":"tool_result","tool_id":"t1","status":"success"}\n'
    # Two assistant deltas so the harness must concatenate them.
    body=$(printf 'GEMINI_REPLY: stdin=%s prompt=%s' "$last_stdin_line" "$prompt")
    head="${body:0:20}"
    tail="${body:20}"
    printf '{"type":"message","role":"assistant","content":"%s","delta":true}\n' "$(json_escape "$head")"
    printf '{"type":"message","role":"assistant","content":"%s","delta":true}\n' "$(json_escape "$tail")"
    printf '{"type":"result","status":"success","stats":{"total_tokens":42,"input_tokens":30,"output_tokens":12}}\n'
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
    # Wrap argv inside a single fake assistant message so the harness's
    # stream-json parser still picks up the content as `text`. The test
    # asserts on substrings.
    joined=""
    for a in "$@"; do
      if [ -z "$joined" ]; then
        joined="$a"
      else
        joined="$joined | $a"
      fi
    done
    printf '{"type":"message","role":"assistant","content":"%s","delta":true}\n' "$(json_escape "$joined")"
    printf '{"type":"result","status":"success","stats":{}}\n'
    exit 0
    ;;
  *)
    echo "fake-gemini.sh: unknown FAKE_GEMINI_MODE=$mode" >&2
    exit 2
    ;;
esac
