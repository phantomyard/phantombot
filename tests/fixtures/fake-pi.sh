#!/bin/bash
# Fake pi CLI used by tests/harnesses-pi.test.ts.
#
# Selects behavior via FAKE_PI_MODE. Pi takes the payload as its last
# positional arg; we don't validate it here.
#
# Modes:
#   normal   — emit text deltas + tool_execution events + turn_end, exit 0
#   error    — exit 1
#   notfound — exit 127
#   hang     — sleep forever (for the timeout test)

mode="${FAKE_PI_MODE:-normal}"

case "$mode" in
  normal)
    printf '%s\n' '{"type":"agent_start"}'
    printf '%s\n' '{"type":"message_update","data":{"text_delta":"hello "}}'
    printf '%s\n' '{"type":"message_update","data":{"text_delta":"world"}}'
    printf '%s\n' '{"type":"tool_execution_start","data":{"tool_name":"bash"}}'
    printf '%s\n' '{"type":"tool_execution_end"}'
    printf '%s\n' '{"type":"turn_end"}'
    exit 0
    ;;
  error)
    echo "simulated pi error" >&2
    exit 1
    ;;
  notfound)
    exit 127
    ;;
  hang)
    exec sleep 3600
    ;;
  *)
    echo "fake-pi.sh: unknown FAKE_PI_MODE=$mode" >&2
    exit 2
    ;;
esac
