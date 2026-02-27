# TriChat Bridges

This folder contains command adapter wrappers used by TriChat and `trichat-tui`.

Default wrappers:

- `codex_bridge.py` -> calls `codex exec` non-interactively.
- `cursor_bridge.py` -> calls `cursor-agent --print` non-interactively.
- `local-imprint_bridge.py` -> deterministic math assist + local Ollama fallback.
- `trichat_bus_client.py` -> publish/subscribe CLI for the Unix socket live event bus.

All wrappers implement the strict adapter contract:

- read one JSON payload from stdin with:
  - `op`: `ask` or `ping`
  - `protocol_version`: `trichat-bridge-v1`
  - `request_id`: non-empty correlation id
  - `agent_id`: target adapter id
- for `ask`, respond on stdout with one JSON object:
  - `kind`: `trichat.adapter.response`
  - `protocol_version`: `trichat-bridge-v1`
  - `request_id`: must match request
  - `agent_id`: must match request
  - `content`: non-empty reply
- for `ping`, respond on stdout with one JSON object:
  - `kind`: `trichat.adapter.pong`
  - `protocol_version`: `trichat-bridge-v1`
  - `request_id`: must match request
  - `agent_id`: must match request
- write all operational/debug logs to stderr only

When `thread_id` is present in the bridge payload, codex/cursor wrappers also emit
best-effort live bus events (`adapter.turn.started|succeeded|failed`) over the local
Unix socket.

## Auto-Wiring

TriChat clients auto-discover wrappers at:

- `./bridges/codex_bridge.py`
- `./bridges/cursor_bridge.py`
- `./bridges/local-imprint_bridge.py` (also supports `./bridges/local_imprint_bridge.py`)

You can override with:

- `TRICHAT_CODEX_CMD`
- `TRICHAT_CURSOR_CMD`
- `TRICHAT_IMPRINT_CMD`
- CLI flags `--codex-command` / `--cursor-command`

## Bridge Doctor

Run:

```bash
python3 ./bridges/bridge_doctor.py
```

This verifies:

- `codex` CLI presence and `codex exec --help`
- `cursor-agent` CLI presence and `cursor-agent --help`
- `ollama` CLI presence and `ollama list` status
- `codex login status` and `cursor-agent status` authentication readiness
- wrapper self-tests

If auth is missing, run:

- `codex login`
- `cursor-agent login`

## Useful Environment Variables

Codex bridge:

- `TRICHAT_CODEX_BIN` (default `codex`)
- `TRICHAT_CODEX_TIMEOUT` (default `180`)
- `TRICHAT_CODEX_MODEL`
- `TRICHAT_CODEX_PROFILE`
- `TRICHAT_CODEX_SANDBOX`
- `TRICHAT_CODEX_APPROVAL`
- `TRICHAT_CODEX_EXTRA_ARGS`
- `TRICHAT_CODEX_EPHEMERAL` (default `1`)
- `TRICHAT_CODEX_SKIP_GIT_CHECK` (default `1`)

Cursor bridge:

- `TRICHAT_CURSOR_BIN` (default `cursor-agent`)
- `TRICHAT_CURSOR_TIMEOUT` (default `180`)
- `TRICHAT_CURSOR_MODEL`
- `TRICHAT_CURSOR_MODE` (`ask` or `plan`)
- `TRICHAT_CURSOR_SANDBOX` (`enabled` or `disabled`)
- `TRICHAT_CURSOR_FORCE` (default `1`)
- `TRICHAT_CURSOR_APPROVE_MCPS` (default `1`)
- `TRICHAT_CURSOR_EXTRA_ARGS`

Local-imprint bridge:

- `TRICHAT_IMPRINT_MODEL` (falls back to `TRICHAT_OLLAMA_MODEL`, default `llama3.2:3b`)
- `TRICHAT_IMPRINT_TIMEOUT` (default `75`)
- `TRICHAT_IMPRINT_SYSTEM_PROMPT`
- `TRICHAT_IMPRINT_TEMPERATURE` (default `0.15`)
- `TRICHAT_IMPRINT_MATH_ASSIST` (default `1`; deterministic arithmetic path)
- `TRICHAT_IMPRINT_MATH_DECIMAL_PLACES` (default `12`)

Shared:

- `TRICHAT_BRIDGE_PYTHON` (python interpreter used for auto command strings)
- `TRICHAT_BRIDGE_MAX_CHARS` (default `12000`)
- `TRICHAT_BRIDGE_DRY_RUN=1` (smoke payload handling without calling model CLIs)
- `TRICHAT_BRIDGE_BUS_EVENTS` (default `1`, enable bridge -> bus publish)
- `TRICHAT_BRIDGE_BUS_WARN` (default `0`, emit stderr warnings on bus publish failures)
- `TRICHAT_BUS_SOCKET_PATH` (override Unix socket path; default `./data/trichat.bus.sock`)
- `TRICHAT_ADAPTER_HANDSHAKE_TTL_SECONDS` (default `120`, how long TUI caches successful command-adapter ping)

## Bus Client Examples

Read bus status:

```bash
python3 ./bridges/trichat_bus_client.py status
```

Subscribe to live events for one thread:

```bash
python3 ./bridges/trichat_bus_client.py subscribe --thread-id trichat-123 --run-seconds 30
```

Publish an out-of-band event:

```bash
python3 ./bridges/trichat_bus_client.py publish \
  --thread-id trichat-123 \
  --event-type adapter.note \
  --source-agent codex \
  --content "manual adapter note"
```
