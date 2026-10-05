# Environment variable reference

Environment variables are the highest-precedence configuration layer. Prefer
the interactive configuration commands and `config.toml` for durable settings;
use environment variables for service deployment, recovery, and isolated tests.
Secrets belong in `phantombot vault`, not in a checked-in environment file.

Boolean switches accept `0`, `off`, `false`, or `no` to disable. A suffixed
persona form such as `PHANTOMBOT_PRIMARY_MODEL_LENA` targets that persona and
outranks the unsuffixed host value.

## Paths and host identity

| Variable | Purpose |
|---|---|
| `PHANTOMBOT_CONFIG` | Override the host `config.toml` path. |
| `PHANTOMBOT_PERSONAS_DIR` | Override the personas root. |
| `PHANTOMBOT_MEMORY_DB` | Override the shared memory database path. |
| `PHANTOMBOT_DEFAULT_PERSONA` | Override the configured default persona. |
| `PHANTOMBOT_AUTOSTART_PERSONAS` | Override the additional boot roster. |
| `PHANTOMBOT_STATE`, `PHANTOMBOT_STATE_AUDIT` | Override internal state files. |
| `PHANTOMBOT_TMP_DIR` | Override the persona-scoped temporary directory. |
| `PHANTOMBOT_SERVICE_PATH`, `PHANTOMBOT_UNIT_NAME`, `PHANTOMBOT_PLIST_LABEL` | Override installed service identity or executable path. |
| `PHANTOMBOT_TZ` | Set the scheduler timezone. |
| `PHANTOMBOT_LOG_LEVEL`, `PHANTOMBOT_LOG_MAX_BYTES`, `PHANTOMBOT_LOG_KEEP` | Control log detail and rotation. |

`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `XDG_STATE_HOME` relocate the standard
roots. `PHANTOMBOT_ENV_FILE` and `PHANTOMBOT_USER_ENV_FILE` are migration and
service-bootstrap compatibility inputs; new credentials must use the vault.

## Harnesses and models

| Variable | Purpose |
|---|---|
| `PHANTOMBOT_HARNESS_CHAIN` | Override the ordered harness chain. |
| `PHANTOMBOT_PRIMARY_MODEL`, `PHANTOMBOT_CODING_MODEL` | Override primary and coding models. |
| `PHANTOMBOT_CLAUDE_MODEL`, `PHANTOMBOT_CLAUDE_FALLBACK_MODEL`, `PHANTOMBOT_CODEX_MODEL` | Pin harness-specific models. |
| `PHANTOMBOT_CLAUDE_BIN`, `PHANTOMBOT_CODEX_BIN`, `PHANTOMBOT_PI_BIN`, `PHANTOMBOT_PI_COMMAND` | Override harness executables or the Pi command. |
| `PHANTOMBOT_PI_PROVIDER`, `PHANTOMBOT_PI_KEY_ENV`, `PHANTOMBOT_PI_MAX_OLD_SPACE_MB`, `PHANTOMBOT_PI_MAX_PAYLOAD` | Configure Pi routing and resource limits. |
| `PHANTOMBOT_IMAGE_MODEL` | Override the image-capable model. |
| `PHANTOMBOT_HARNESS_STARTUP_TIMEOUT_MS`, `PHANTOMBOT_HARNESS_THINKING_TIMEOUT_MS`, `PHANTOMBOT_HARNESS_SOFT_TIMEOUT_MS`, `PHANTOMBOT_HARNESS_IDLE_TIMEOUT_MS`, `PHANTOMBOT_HARNESS_TOOL_TIMEOUT_MS`, `PHANTOMBOT_HARNESS_HARD_TIMEOUT_MS` | Override watchdog stages. A zero soft timeout disables soft nudges. |
| `PHANTOMBOT_HARNESS_NUDGE_CAP` | Limit soft-timeout nudges. |
| `PHANTOMBOT_TURN_TIMEOUT_MS` | Set the overall turn deadline used by channel orchestration. |
| `PHANTOMBOT_COOLDOWN_STATE` | Relocate harness cooldown state. |

Model, binary, chain, Telegram, and Pi key variables also support an uppercase
persona suffix. Examples include `PHANTOMBOT_PRIMARY_MODEL_LENA`,
`PHANTOMBOT_CLAUDE_MODEL_LENA`, and `PHANTOMBOT_PI_API_KEY_PI_PRIMARY`.
`PHANTOMBOT_INJECTED_CLAUDE_SETTINGS`, `PHANTOMBOT_INJECTED_CODEX_FLAGS`,
`PHANTOMBOT_JUDGE_CODEX_FLAGS`, and `PHANTOMBOT_ROUTING_JSON` are generated
harness inputs; operators normally should not set them.

## Providers and credentials

Store these names in the persona vault when possible:

- `PHANTOMBOT_GEMINI_API_KEY`
- `PHANTOMBOT_OPENAI_API_KEY`
- `PHANTOMBOT_OPENAI_COMPATIBLE_API_KEY`
- `PHANTOMBOT_VOICE_OPENAI_COMPATIBLE_API_KEY`
- `PHANTOMBOT_ELEVENLABS_API_KEY`
- `PHANTOMBOT_PI_API_KEY` and persona/instance-suffixed Pi key names
- `PHANTOMBOT_JEV_API_KEY`

OpenAI-compatible embeddings also accept
`PHANTOMBOT_OPENAI_COMPATIBLE_BASE_URL`,
`PHANTOMBOT_OPENAI_COMPATIBLE_MODEL`,
`PHANTOMBOT_OPENAI_COMPATIBLE_DIMS`,
`PHANTOMBOT_OPENAI_COMPATIBLE_QUERY_PREFIX`, and
`PHANTOMBOT_OPENAI_COMPATIBLE_DOCUMENT_PREFIX`. The optional decision model
accepts `PHANTOMBOT_JEV_PROVIDER`, `PHANTOMBOT_JEV_BASE_URL`,
`PHANTOMBOT_JEV_MODEL`, `PHANTOMBOT_JEV_KEY_ENV`, `PHANTOMBOT_JEV_JUDGE`, and
`PHANTOMBOT_JEV_ROUTER`.

## Channels, voice, and presentation

| Variable | Purpose |
|---|---|
| `PHANTOMBOT_TELEGRAM_ALLOWED_USERS`, `PHANTOMBOT_TELEGRAM_POLL_S`, `PHANTOMBOT_TELEGRAM_GROUP_PERSONAS` | Configure Telegram access, polling, and group routing; persona-suffixed forms are supported. |
| `PHANTOMBOT_TELEGRAM_BUBBLE_DELAY_MS`, `PHANTOMBOT_TELEGRAM_BUBBLE_MAX_CHARS`, `PHANTOMBOT_TELEGRAM_BUBBLE_MAX_SENTENCES`, `PHANTOMBOT_TELEGRAM_NARRATION_FLUSH_MS`, `PHANTOMBOT_TELEGRAM_VOICE_MAX_SENTENCES` | Tune Telegram streaming and voice segmentation. |
| `PHANTOMBOT_CHATTINESS`, `PHANTOMBOT_CHATTINESS_STATE`, `PHANTOMBOT_REPLY_MODE_STATE` | Override or relocate per-conversation presentation state. |
| `PHANTOMBOT_APP_TITLE`, `PHANTOMBOT_APP_URL` | Set the application identity exposed to clients. |
| `PHANTOMBOT_TUI_FRAME`, `PHANTOMBOT_TUI_LOG_LINES` | Tune terminal presentation. |

## Memory, retrieval, and prompt caching

`PHANTOMBOT_PROMPT_CACHE_ENABLED` and
`PHANTOMBOT_PROMPT_CACHE_MAX_EPOCH_BYTES` control hosted prompt-cache epochs.

Retrieval overrides are `PHANTOMBOT_RETRIEVAL_ENABLED`,
`PHANTOMBOT_RETRIEVAL_LIMIT`, `PHANTOMBOT_RETRIEVAL_MAX_TOKENS`,
`PHANTOMBOT_RETRIEVAL_MIN_SCORE`, `PHANTOMBOT_RETRIEVAL_DECAY_ENABLED`,
`PHANTOMBOT_RETRIEVAL_DECAY_FLOOR`,
`PHANTOMBOT_RETRIEVAL_DECAY_HALF_LIFE_DAYS`,
`PHANTOMBOT_RETRIEVAL_GRAPH_EXPANSION_ENABLED`,
`PHANTOMBOT_RETRIEVAL_GRAPH_HOPS`, `PHANTOMBOT_RETRIEVAL_GRAPH_MAX_ADD`,
`PHANTOMBOT_RETRIEVAL_TURN_INDEXING_ENABLED`,
`PHANTOMBOT_RETRIEVAL_TURN_INDEXING_INTERVAL`,
`PHANTOMBOT_RETRIEVAL_TURN_INDEXING_BATCH_SIZE`,
`PHANTOMBOT_RETRIEVAL_TURN_INDEXING_REPAIR_BATCH_SIZE`,
`PHANTOMBOT_RETRIEVAL_TURN_INDEXING_FLUSH_AFTER_HOURS`,
`PHANTOMBOT_RETRIEVAL_CROSS_ENABLED`, `PHANTOMBOT_RETRIEVAL_CROSS_LIMIT`,
`PHANTOMBOT_RETRIEVAL_CROSS_MIN_SCORE`,
`PHANTOMBOT_RETRIEVAL_CROSS_MIN_VEC_SCORE`, and
`PHANTOMBOT_RETRIEVAL_CROSS_EXCLUDE`.

The compatibility durable-facts extractor uses
`PHANTOMBOT_DURABLE_FACTS_ENABLED`, `PHANTOMBOT_DURABLE_FACTS_DEBUG`,
`PHANTOMBOT_DURABLE_FACTS_MIN_CONFIDENCE`,
`PHANTOMBOT_DURABLE_FACTS_INJECT_FLOOR`,
`PHANTOMBOT_DURABLE_FACTS_MAX_INJECTED`,
`PHANTOMBOT_DURABLE_FACTS_MAX_EXTRACT_PER_TURN`, and
`PHANTOMBOT_DURABLE_FACTS_LEASE_MS`.

## Concurrency, audit, updates, and transport

| Variable | Purpose |
|---|---|
| `PHANTOMBOT_TURN_REGISTRY`, `PHANTOMBOT_TURN_REGISTRY_DIR` | Disable or relocate the active-turn registry. |
| `PHANTOMBOT_TURN_DIGEST`, `PHANTOMBOT_TURN_DIGEST_DIR` | Disable or relocate background-turn digests. |
| `PHANTOMBOT_WORKSPACE_LOCKS`, `PHANTOMBOT_WORKSPACE_LOCK_DIR` | Disable or relocate advisory workspace claims. |
| `PHANTOMBOT_PROCESS_START_PROBE` | Disable helper-based process identity probing on macOS/Windows. |
| `PHANTOMBOT_AUDIT_TOOL_CALLS`, `PHANTOMBOT_AUDIT_RETENTION_DAYS` | Control tool-call audit recording and retention. |
| `PHANTOMBOT_SANDBOX`, `PHANTOMBOT_EXEC_NAMES` | Control the sandbox and executable allow-list compatibility surface. |
| `PHANTOMBOT_UPDATE_CHANNEL`, `PHANTOMBOT_UPDATE_REPO` | Override update ring and release repository. |
| `PHANTOMBOT_P2P_ENABLED`, `PHANTOMBOT_P2P_PORT`, `PHANTOMBOT_P2P_STUN`, `PHANTOMBOT_P2P_ALLOWED_ORIGINS` | Configure the optional P2P transport. |
| `PHANTOMBOT_WINDOWS_PASSWORD` | Supply Windows scheduled-task credentials; prefer the vault. |

## Runtime-owned and test-only values

Phantombot injects `PHANTOMBOT_PERSONA`, `PHANTOMBOT_CONVERSATION`,
`PHANTOMBOT_TURN_ID`, `PHANTOMBOT_TRUST`, and `PHANTOMBOT_ENGINE_SCOPE` into
scoped child processes. Treat them as runtime context, not host configuration.
`PHANTOMBOT_TEST_ISOLATION_ROOT` is test-only. Installer-only controls include
`PHANTOMBOT_INSTALL_DIR` and `PHANTOMBOT_SKIP_TUI`.
