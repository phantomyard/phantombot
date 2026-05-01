#!/bin/bash
# Fake pi CLI used by tests/harnesses-pi.test.ts.
#
# Schema mirrors what `pi --print --mode json` actually emits as of
# pi v0.67.x: text_delta lives in assistantMessageEvent.delta, not
# data.text_delta.
#
# Modes:
#   normal   — emit thinking + text deltas + turn_end, exit 0
#   error    — exit 1
#   notfound — exit 127
#   hang     — sleep forever (for the timeout test)

mode="${FAKE_PI_MODE:-normal}"

case "$mode" in
  normal)
    printf '%s\n' '{"type":"session","version":3,"id":"abc"}'
    printf '%s\n' '{"type":"agent_start"}'
    printf '%s\n' '{"type":"turn_start"}'
    # Thinking deltas — must be IGNORED by the parser.
    printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"thinking_start","contentIndex":0,"partial":{}},"message":{}}'
    printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"think","partial":{}},"message":{}}'
    printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"thinking_end","contentIndex":0,"content":"think","partial":{}},"message":{}}'
    # Real text deltas — the parser should emit these as text chunks.
    printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_start","contentIndex":1,"partial":{}},"message":{}}'
    printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"hello ","partial":{}},"message":{}}'
    printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"world","partial":{}},"message":{}}'
    printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_end","contentIndex":1,"content":"hello world","partial":{}},"message":{}}'
    printf '%s\n' '{"type":"message_end","message":{}}'
    printf '%s\n' '{"type":"turn_end","message":{},"toolResults":[]}'
    printf '%s\n' '{"type":"agent_end","messages":[]}'
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
