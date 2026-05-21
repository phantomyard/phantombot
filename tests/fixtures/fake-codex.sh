#!/bin/bash
# Fake codex CLI used by tests/harnesses-codex.test.ts.
# Modes via FAKE_CODEX_MODE:
#   normal   -> one agent message + turn.completed, exit 0
#   error    -> stderr + exit 1
#   notfound -> exit 127
#   hang     -> sleep forever
#   argv     -> echo argv in an agent message

mode="${FAKE_CODEX_MODE:-normal}"

# Drain stdin so harness stdin.end() resolves.
stdin_payload="$(cat)"

case "$mode" in
  normal)
    printf '%s\n' '{"type":"thread.started","thread_id":"t1"}'
    printf '%s\n' '{"type":"turn.started"}'
    printf '%s\n' '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"hello codex"}}'
    printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}'
    exit 0
    ;;
  error)
    echo "simulated codex error" >&2
    exit 1
    ;;
  notfound)
    exit 127
    ;;
  hang)
    exec sleep 3600
    ;;
  argv)
    payload="$*"
    payload="${payload//\\/\\\\}"
    payload="${payload//\"/\\\"}"
    printf '%s\n' "{\"type\":\"item.completed\",\"item\":{\"id\":\"i1\",\"type\":\"agent_message\",\"text\":\"argv:${payload}\"}}"
    printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
    exit 0
    ;;
  *)
    echo "fake-codex.sh: unknown FAKE_CODEX_MODE=$mode" >&2
    exit 2
    ;;
esac
