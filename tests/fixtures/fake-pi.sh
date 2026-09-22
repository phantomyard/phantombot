#!/bin/bash
# Fake pi CLI used by tests/harnesses-pi.test.ts.
#
# Schema mirrors what `pi --print --mode json` actually emits as of
# pi v0.67.x: text_delta lives in assistantMessageEvent.delta, not
# data.text_delta.
#
# Modes:
#   normal   — emit thinking + text deltas + turn_end, exit 0
#   nofinish — emit tool-narration text deltas then exit 0 WITHOUT turn_end
#              (the #352 "stopped mid-turn" case: must fall through, not 'done')
#   error    — exit 1
#   signal   — write stderr, then terminate by SIGKILL
#   notfound — exit 127
#   hang     — sleep forever (for the timeout test)
#   toolthenfail — run one tool (tool_execution_start → progress chunk), then
#              exit 1 like a provider death: an attempt that DID real,
#              side-effecting work before dying. Drives the producedOutput
#              ladder test (tools aren't idempotent → no retry).
#   stallaftertools — the 2026-09-20 TUI incident (#598, pi case): narration
#              text BEFORE tools, two real tool rounds, then turn_end fires
#              anyway and pi exits 0 — the stream died after the tool results
#              and pi treated the truncated turn as finished. Must be a
#              recoverable error, NOT done.
#   toolsdone — healthy control for the same guard: tools run, then the model
#              replies with text AFTER the last tool result, then turn_end.
#              Must yield done with the full text.
#   argv     — echo argv (joined) as a text_delta, exit 0 (arg-shape test)
#   env      — echo the PHANTOMBOT_*_MODEL env vars + the PI provider/api-key
#              as a text_delta, exit 0 (routing env-projection test)
#   modelgate — append each invocation's argv (one line) to $FAKE_PI_ARGV_LOG,
#              then exit 1 when argv contains `--model $FAKE_PI_FAIL_MODEL`,
#              else behave like `normal`. Lets a test make ONE configured
#              model fail while the other succeeds — the coder-swap retry
#              ladder / primary-fallback tests.
#   ratelimit — exit 1 with provider rate-limit prose on stderr (the #559
#              first-signal abort: the coder-swap ladder must NOT retry).

mode="${FAKE_PI_MODE:-normal}"

# Record this invocation's argv (one line) when a test asks for it — used by
# the coder-swap retry-ladder tests to COUNT attempts across modes.
if [ -n "${FAKE_PI_ARGV_LOG-}" ]; then
  printf '%s\n' "$*" >>"$FAKE_PI_ARGV_LOG"
fi

emit_normal() {
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
}


case "$mode" in
  argv)
    joined="$*"
    printf '%s\n' "{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"contentIndex\":0,\"delta\":\"argv: ${joined}\",\"partial\":{}},\"message\":{}}"
    printf '%s\n' '{"type":"turn_end","message":{},"toolResults":[]}'
    exit 0
    ;;
  env)
    # The per-persona routing file the harness points us at (phantombot#441).
    # Echo its CONTENTS, not just the path: what the test needs to know is which
    # persona's delegate models this child would actually route with. Quotes are
    # escaped so the JSON line below stays parseable.
    routejson=""
    if [ -n "${PHANTOMBOT_ROUTING_JSON-}" ] && [ -f "${PHANTOMBOT_ROUTING_JSON}" ]; then
      routejson=$(tr -d '\n ' < "${PHANTOMBOT_ROUTING_JSON}" | sed 's/"/\\"/g')
    fi
    joined="primary=${PHANTOMBOT_PRIMARY_MODEL-} image=${PHANTOMBOT_IMAGE_MODEL-} coding=${PHANTOMBOT_CODING_MODEL-} provider=${PHANTOMBOT_PI_PROVIDER-} apikey=${PHANTOMBOT_PI_API_KEY-} nodeopts=${NODE_OPTIONS-} routing=${routejson} keyenv=${PHANTOMBOT_PI_KEY_ENV-}"
    # The provider's NATIVE key var (named by PHANTOMBOT_PI_KEY_ENV), echoed via
    # indirect expansion so tests can assert the key relayed under it (#602).
    if [ -n "${PHANTOMBOT_PI_KEY_ENV-}" ]; then
      joined+=" native=${PHANTOMBOT_PI_KEY_ENV}=${!PHANTOMBOT_PI_KEY_ENV}"
    fi
    # RESOLUTION LAYER (PR #606 review): mimic real pi's precedence — a STORED
    # credential in the agent dir's auth.json beats env vars — and report which
    # key this child would ACTUALLY authenticate with. This is the assertion
    # surface for the env-only-resolution contract: if the harness left the
    # provider's entry in the persona's native store, `resolved=` shows the
    # stale stored key, not the relayed one.
    resolved=""
    if [ -n "${PI_CODING_AGENT_DIR-}" ] && [ -f "${PI_CODING_AGENT_DIR}/auth.json" ] && [ -n "${PHANTOMBOT_PI_PROVIDER-}" ]; then
      # Stored credential beats env — ANY stored credential: an api_key entry
      # resolves its "key", an oauth login its "access" token (PR #606
      # re-review: an oauth survivor outranks the relayed env key too).
      stored=$(grep -A3 "\"${PHANTOMBOT_PI_PROVIDER}\"" "${PI_CODING_AGENT_DIR}/auth.json" \
        | grep -o '"\(access\|key\)"[[:space:]]*:[[:space:]]*"[^"]*"' \
        | head -1 | sed 's/.*:[[:space:]]*"//;s/"$//')
      resolved="$stored"
    fi
    if [ -z "$resolved" ] && [ -n "${PHANTOMBOT_PI_KEY_ENV-}" ]; then
      resolved="${!PHANTOMBOT_PI_KEY_ENV}"
    fi
    joined+=" resolved=${resolved}"
    printf '%s\n' "{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"contentIndex\":0,\"delta\":\"env: ${joined}\",\"partial\":{}},\"message\":{}}"
    printf '%s\n' '{"type":"turn_end","message":{},"toolResults":[]}'
    exit 0
    ;;
  normal)
    emit_normal
    ;;
  modelgate)
    for arg in "$@"; do
      if [ "${FAKE_PI_FAIL_MODEL-}" = "*" ] ||
         { [ -n "${FAKE_PI_FAIL_MODEL-}" ] && [ "$arg" = "$FAKE_PI_FAIL_MODEL" ]; }; then
        echo "simulated failure for model $arg" >&2
        exit 1
      fi
    done
    emit_normal
    ;;
  nofinish)
    printf '%s\n' '{"type":"session","version":3,"id":"abc"}'
    printf '%s\n' '{"type":"agent_start"}'
    printf '%s\n' '{"type":"turn_start"}'
    # Only tool narration — real answer never produced, and crucially NO turn_end.
    printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Ik ga de repo ophalen...","partial":{}},"message":{}}'
    printf '%s\n' '{"type":"tool_execution_start","toolName":"bash","args":{}}'
    # Process exits 0 mid-task with no turn_end completion signal.
    exit 0
    ;;
  toolthenfail)
    printf '%s\n' '{"type":"session","version":3,"id":"abc"}'
    printf '%s\n' '{"type":"agent_start"}'
    printf '%s\n' '{"type":"turn_start"}'
    # One real tool run — surfaces as a PROGRESS chunk (not text) in the
    # harness stream, exactly like a bash/notify/vault side effect.
    printf '%s\n' '{"type":"tool_execution_start","toolName":"bash","args":{"command":"echo side-effect"}}'
    printf '%s\n' '{"type":"tool_execution_end","toolName":"bash","result":{}}'
    exit 1
    ;;
  stallaftertools)
    # The 2026-09-20 TUI incident, issue #598: narration before the tools, two
    # real tool rounds (with toolCallId so the boundary tracker sees them),
    # then turn_end WITHOUT any text after the tool results. Exit 0.
    printf '%s\n' '{"type":"session","version":3,"id":"abc"}'
    printf '%s\n' '{"type":"agent_start"}'
    printf '%s\n' '{"type":"turn_start"}'
    printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Good question - let me check the routing.","partial":{}},"message":{}}'
    printf '%s\n' '{"type":"tool_execution_start","toolCallId":"tc1","toolName":"bash","args":{"command":"ls"}}'
    printf '%s\n' '{"type":"tool_execution_end","toolCallId":"tc1","toolName":"bash","result":{}}'
    printf '%s\n' '{"type":"tool_execution_start","toolCallId":"tc2","toolName":"bash","args":{"command":"pwd"}}'
    printf '%s\n' '{"type":"tool_execution_end","toolCallId":"tc2","toolName":"bash","result":{}}'
    printf '%s\n' '{"type":"turn_end","message":{},"toolResults":[]}'
    exit 0
    ;;
  toolsdone)
    # Healthy tool turn: one tool round, then reply text AFTER the tool result,
    # then turn_end. The post-tool-text guard must let this through as done.
    printf '%s\n' '{"type":"session","version":3,"id":"abc"}'
    printf '%s\n' '{"type":"agent_start"}'
    printf '%s\n' '{"type":"turn_start"}'
    printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Checking...","partial":{}},"message":{}}'
    printf '%s\n' '{"type":"tool_execution_start","toolCallId":"tc1","toolName":"bash","args":{"command":"ls"}}'
    printf '%s\n' '{"type":"tool_execution_end","toolCallId":"tc1","toolName":"bash","result":{}}'
    printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"Here is the answer.","partial":{}},"message":{}}'
    printf '%s\n' '{"type":"turn_end","message":{},"toolResults":[]}'
    exit 0
    ;;
  ratelimit)
    # FAKE_PI_RATELIMIT_TEXT overrides the stderr prose so tests can drive
    # the classifier with real provider wording (review on #561).
    echo "${FAKE_PI_RATELIMIT_TEXT:-provider error: 429 rate_limit exceeded}" >&2
    exit 1
    ;;
  error)
    echo "simulated pi error" >&2
    exit 1
    ;;
  signal)
    echo "simulated pi signal failure" >&2
    kill -KILL $$
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
