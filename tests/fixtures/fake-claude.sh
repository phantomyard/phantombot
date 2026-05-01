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
  *)
    echo "fake-claude.sh: unknown FAKE_CLAUDE_MODE=$mode" >&2
    exit 2
    ;;
esac
