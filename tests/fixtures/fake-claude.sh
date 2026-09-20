#!/bin/bash
# Fake claude CLI used by tests/harnesses-claude.test.ts.
#
# Selects behavior via FAKE_CLAUDE_MODE. Drains stdin so the harness's
# stdin.write/end doesn't see EPIPE. Ignores all the --print/--system-prompt/
# etc. flags the real claude takes — we don't validate them here.
#
# Modes:
#   normal   — emit two assistant text chunks + a result event, exit 0
#   error    — emit a stderr line, exit 1
#   notfound — exit 127 (terminal, simulates "command not found")
#   hang     — sleep forever (used for the timeout test)
#   argv     — emit argv as a single assistant text event (so the test can
#              inspect what flags the harness passed), then exit 0
#   env      — emit select env vars as a text event (so the test can inspect
#              the env the harness spawned us with), then exit 0
#   posttool_thinking — tool_use -> user tool_result -> spaced thinking
#              heartbeats -> final text. Proves user-side tool_result clears
#              the tool-running idle latch.
#   narration_only — narration text + tool_use, then exit 0 WITHOUT a result
#              envelope: the truncated-stream failure mode of issue #598. Must
#              surface as a recoverable error, never a succeeded turn.
#   result_error — text + a result envelope with is_error:true, exit 0: a
#              failure the exit code hides (issue #598).

mode="${FAKE_CLAUDE_MODE:-normal}"

# Drain stdin so the parent's stdin.end() resolves cleanly. Without this
# the harness can hang on `proc.stdin.end()` if the kernel buffer fills.
cat > /dev/null

case "$mode" in
  normal)
    printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"hello "}]}}'
    printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"world"}]}}'
    printf '%s\n' '{"type":"result"}'
    exit 0
    ;;
  error)
    echo "simulated error" >&2
    exit 1
    ;;
  notfound)
    exit 127
    ;;
  hang)
    # `exec` replaces bash with sleep so SIGTERM from the harness reaches
    # the actual blocking process. Without exec, bash absorbs SIGTERM and
    # the orphaned sleep keeps stdout open, leaking the timeout into a hang.
    exec sleep 3600
    ;;
  argv)
    # Emit our argv as a single assistant text event so the test can verify
    # which flags the harness passed (e.g. --settings + the deny-list JSON).
    # jq isn't guaranteed to be available on the target hosts, so build the
    # JSON by hand and escape characters that would break stream-json: \, ".
    payload="$*"
    payload="${payload//\\/\\\\}"
    payload="${payload//\"/\\\"}"
    printf '%s\n' "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"${payload}\"}]}}"
    printf '%s\n' '{"type":"result"}'
    exit 0
    ;;
  env)
    # Echo the background-tasks flag the harness is expected to inject, so
    # tests can prove it reaches the subprocess env (and that an inherited
    # CLAUDE_CODE_* value can't smuggle a different one through filterAuthEnv).
    v="${CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:-<unset>}"
    printf '%s\n' "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"BGTASKS=${v}\"}]}}"
    printf '%s\n' '{"type":"result"}'
    exit 0
    ;;
  posttool_thinking)
    printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{}}]}}'
    sleep 0.1
    printf '%s\n' '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"abc","content":"done"}]}}'
    sleep 0.45
    printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"still working"}]}}'
    sleep 0.45
    printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"still working"}]}}'
    sleep 0.45
    printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"finished"}]}}'
    printf '%s\n' '{"type":"result"}'
    exit 0
    ;;
  narration_only)
    # The wire shape of the 2026-09-20 TUI stall: the model narrated, called
    # a tool, and the stream died — CLI still exits 0, no result envelope.
    printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"Good question — let me check that."}]}}'
    printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}]}}'
    exit 0
    ;;
  result_error)
    printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}'
    printf '%s\n' '{"type":"result","subtype":"error_during_execution","is_error":true}'
    exit 0
    ;;
  *)
    echo "fake-claude.sh: unknown FAKE_CLAUDE_MODE=$mode" >&2
    exit 2
    ;;
esac
