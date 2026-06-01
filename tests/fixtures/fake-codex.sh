#!/bin/bash
# Fake codex CLI used by tests/harnesses-codex.test.ts.
# Modes via FAKE_CODEX_MODE:
#   normal     -> one agent message + turn.completed, exit 0
#   error      -> stderr + exit 1
#   notfound   -> exit 127
#   hang       -> sleep forever
#   argv       -> echo argv in an agent message
#   heartbeats -> stream model heartbeats spaced under the idle window for
#                 ~3s, then an agent_message + turn.completed. Used to prove
#                 model-side activity can keep a genuinely busy turn alive.
#   tool-heartbeats -> start a tool, then stream heartbeats spaced under the
#                 idle window before a late finish. Used to prove generic
#                 heartbeat noise does NOT keep a tool-stuck turn alive.
#   productive -> stream agent_message text spaced under the idle window,
#                 then turn.completed. Used to prove productive output DOES
#                 keep resetting the idle timer, so the turn finishes cleanly.

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
  heartbeats)
    printf '%s\n' '{"type":"turn.started"}'
    for i in $(seq 1 15); do
      printf '%s\n' '{"type":"item.completed","item":{"id":"hb'"$i"'","type":"reasoning","text":"thinking"}}'
      sleep 0.2
    done
    printf '%s\n' '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"late finish"}}'
    printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
    exit 0
    ;;
  tool-heartbeats)
    printf '%s\n' '{"type":"turn.started"}'
    printf '%s\n' '{"type":"item.started","item":{"id":"tool1","type":"tool_call","name":"shell"}}'
    for i in $(seq 1 15); do
      printf '%s\n' '{"type":"item.completed","item":{"id":"hb'"$i"'","type":"reasoning","text":"thinking"}}'
      sleep 0.2
    done
    printf '%s\n' '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"late finish"}}'
    printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
    exit 0
    ;;
  productive)
    for i in $(seq 1 6); do
      printf '%s\n' "{\"type\":\"item.completed\",\"item\":{\"id\":\"i$i\",\"type\":\"agent_message\",\"text\":\"chunk$i \"}}"
      sleep 0.2
    done
    printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":6}}'
    exit 0
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
