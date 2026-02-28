# Anamnesis Connect

This server runs as a local-first MCP hub with STDIO or Streamable HTTP transport.

## Node Version

`better-sqlite3` expects Node LTS + a C++20-capable toolchain.
Use Node 22 (recommended).

## Install + Build

```bash
npm ci
npm run build
```

## STDIO (Recommended)

Run:

```bash
npm run start:stdio
```

Point your MCP client at:

```bash
node /absolute/path/to/MCP_sandbox_playground/dist/server.js
```

Notes:

- The server loads `.env` from repo root automatically.
- Override env path with `DOTENV_CONFIG_PATH=/absolute/path/to/.env`.
- SQLite defaults to `./data/hub.sqlite`.
- Override DB path with `ANAMNESIS_HUB_DB_PATH=/absolute/path/to/hub.sqlite`.
- Legacy fallback: `MCP_HUB_DB_PATH=/absolute/path/to/hub.sqlite`.
- Startup applies deterministic schema migrations and records them in `schema_migrations`.

## HTTP (Streamable)

Run:

```bash
MCP_HTTP_BEARER_TOKEN="change-me" \
MCP_HTTP_ALLOWED_ORIGINS="http://localhost,http://127.0.0.1" \
npm run start:http
```

Notes:

- HTTP binds to `127.0.0.1` / `localhost` only.
- Requires `Authorization: Bearer <token>`.
- Requires allowed `Origin` header.

## Minimal `.env`

```bash
ANAMNESIS_HUB_DB_PATH=./data/hub.sqlite
# MCP_HUB_DB_PATH=./data/hub.sqlite
MCP_HTTP_BEARER_TOKEN=change-me
MCP_HTTP_ALLOWED_ORIGINS=http://localhost,http://127.0.0.1
```

## Validation

Run full local integration suite:

```bash
npm test
```

## Tool Set

- `memory.append`, `memory.get`, `memory.search`
- `imprint.inbox.enqueue`, `imprint.inbox.list`
- `imprint.profile_set`, `imprint.profile_get`, `imprint.snapshot`, `imprint.bootstrap`, `imprint.auto_snapshot`
- `transcript.log`, `transcript.auto_squish`, `transcript.pending_runs`, `transcript.retention`, `transcript.run_timeline`, `transcript.squish`, `transcript.append`, `transcript.summarize`
- `adr.create`
- `who_knows`, `knowledge.query`
- `policy.evaluate`
- `run.begin`, `run.step`, `run.end`, `run.timeline`
- `task.create`, `task.list`, `task.timeline`, `task.claim`, `task.heartbeat`, `task.complete`, `task.fail`, `task.retry`, `task.auto_retry`
- `task.summary`
- `trichat.thread_open`, `trichat.thread_list`, `trichat.thread_get`, `trichat.message_post`, `trichat.timeline`, `trichat.summary`, `trichat.adapter_telemetry`, `trichat.adapter_protocol_check`, `trichat.turn_start`, `trichat.turn_advance`, `trichat.turn_artifact`, `trichat.turn_get`, `trichat.turn_orchestrate`, `trichat.workboard`, `trichat.novelty`, `trichat.verify`, `trichat.retention`, `trichat.auto_retention`, `trichat.autopilot`
- `mutation.check`
- `preflight.check`, `postflight.verify`
- `lock.acquire`, `lock.release`
- `knowledge.promote`, `knowledge.decay`
- `retrieval.hybrid`
- `decision.link`
- `simulate.workflow`
- `health.tools`, `health.storage`, `health.policy`
- `incident.open`, `incident.timeline`
- `query.plan`
- `migration.status`

## MVP Smoke Check

Run the default smoke check (spawns server via STDIO):

```bash
./scripts/mvp_smoke.sh
```

Run against a live HTTP server:

```bash
MCP_SMOKE_TRANSPORT=http \
MCP_HTTP_BEARER_TOKEN="change-me" \
./scripts/mvp_smoke.sh
```

Optional env overrides:

- `MCP_SMOKE_TRANSPORT` (`stdio` or `http`, default `stdio`)
- `MCP_SMOKE_URL` (default `http://127.0.0.1:8787/`, HTTP mode only)
- `MCP_SMOKE_ORIGIN` (default `http://127.0.0.1`, HTTP mode only)
- `MCP_SMOKE_RUN_ID` (default auto-generated)
- `MCP_SMOKE_STDIO_COMMAND` (default `node`)
- `MCP_SMOKE_STDIO_ARGS` (default `dist/server.js`)

## Imprint Bootstrap

Run one-shot profile/snapshot/bootstrap capture:

```bash
./scripts/imprint_bootstrap.sh
```

Or via npm:

```bash
npm run imprint:bootstrap
```

## Launchd Auto-Start + Switches

Install login-time services for local MCP HTTP, imprint auto-snapshot, and inbox worker:

```bash
npm run launchd:install
```

Toggle runtime switches:

```bash
npm run agents:on
npm run agents:off
npm run agents:status
```

Enqueue inbox tasks manually:

```bash
npm run inbox:enqueue -- --objective "Run npm test and summarize failures"
```

## Auto Squish + Retention

Recommended usage pattern:

1. Use `transcript.auto_squish` with `action: "status"` to inspect daemon state.
2. Use `transcript.auto_squish` with `action: "run_once"` for explicit backlog drain.
3. Use `transcript.auto_squish` with `action: "start"` for interval-based draining.
4. Use `transcript.retention` with `dry_run: true` before deleting.

Safety defaults:

- `transcript.retention` only deletes squished lines unless `include_unsquished: true`.
- `transcript.auto_squish` requires mutation metadata for `start`, `stop`, and `run_once`.
- `transcript.auto_squish` persists daemon state/config, so restart restores previous mode.

## TriChat Terminal

Run TriChat with STDIO MCP calls:

```bash
npm run trichat
```

Run TriChat Bubble Tea TUI with STDIO MCP calls:

```bash
npm run trichat:tui
```

Run TriChat against local HTTP MCP:

```bash
npm run start:http
npm run trichat:http
```

Run TriChat Bubble Tea TUI against local HTTP MCP:

```bash
npm run start:http
npm run trichat:tui:http
```

Install a one-click macOS app launcher (single icon):

```bash
npm run trichat:app:install -- --icon /absolute/path/to/three-cats.png
```

This creates `~/Applications/TriChat.app`. Launching it opens TriChat in your terminal mode.

Bridge adapters:

- Auto-default wrappers:
  - `./bridges/codex_bridge.py`
  - `./bridges/cursor_bridge.py`
  - `./bridges/local-imprint_bridge.py` (also supports `local_imprint_bridge.py`)
- Validate bridge readiness:
  - `npm run trichat:bridges:doctor`
- If auth is missing:
  - `codex login`
  - `cursor-agent login`
- Bridge protocol:
  - requests include `op`, `protocol_version=trichat-bridge-v1`, `request_id`, and `agent_id`
  - ask responses must return `kind=trichat.adapter.response` with matching `request_id`
  - ping responses must return `kind=trichat.adapter.pong` with matching `request_id`
  - malformed envelopes fail fast and route through fallback adapters
- Manual overrides (only if needed):
  - `TRICHAT_CODEX_CMD`
  - `TRICHAT_CURSOR_CMD`
  - `TRICHAT_IMPRINT_CMD`

Adapter contract:

- reads one JSON payload from stdin
- writes response text or JSON with `content` field to stdout

TriChat verifies required `trichat.*` + `task.*` tooling at startup and retries MCP tool calls on transient failures.
Each adapter channel (bridge command + Ollama fallback) uses per-agent circuit breakers with recovery windows, so transient bridge/model failures degrade gracefully without stalling fanout turns.
Circuit state and breaker events can be persisted via `trichat.adapter_telemetry` for restart-safe reliability diagnostics.
Consensus analysis is available via `trichat.consensus`, allowing reliability views to auto-flag cross-agent disagreements per user turn.
When a thread flips into disagreement, the server publishes `consensus.alert` on `trichat.bus` for adapter-side automation hooks.
Turn orchestration is persisted via `trichat.turn_*`, with `trichat.workboard` for phase visibility and `trichat.novelty` for forced-delta retry hints before merge.
Use `trichat.turn_orchestrate` to keep merge/execute and verify-finalization deterministic on the server side instead of replicating those transitions in every client.
`trichat.verify` can run local checks during execute/verify transitions so turn completion reflects real project health.
For internal reliability heartbeat threads (`trichat-reliability-*`), novelty includes a dedupe guard that suppresses repeated retries when novelty and selected strategy remain effectively unchanged across consecutive turns.
In TUI Settings, `Consensus Min Agents` toggles between `2` and `3` for live consensus calculations.
The TUI exposes the same runtime path with an interactive split-pane UX (timeline, slash input, reliability sidebar, and settings menu).

TriChat runtime commands for housekeeping:

- `/adapters status|reset [all|codex|cursor|local-imprint]` for adapter breaker inspection/reset.
- `/consensus` for latest cross-agent agreement/disagreement breakdown on the active thread.
- `/workboard [limit]` for orchestration phase/state summary of active thread turns.
- `/turn show [turn_id]` and `/turn phase <phase> [phase_status]` for turn lifecycle debugging.
- `/retention [days] [apply] [all]` for one-shot pruning (`dry_run` by default).
- `/retentiond status|start|stop|run_once` for daemonized tri-chat retention.

`/execute` gate modes:

- `open` (default): no extra constraints before `task.create`.
- `allowlist`: only allow selected agent IDs for `/execute`.
- `approval`: require operator confirmation phrase before `task.create`.

Configure at startup:

```bash
python3 ./scripts/trichat.py --execute-gate-mode open
python3 ./scripts/trichat.py --execute-gate-mode allowlist --execute-allow-agents codex,local-imprint
python3 ./scripts/trichat.py --execute-gate-mode approval --execute-approval-phrase approve
```

Run TriChat message-bus smoke check:

```bash
npm run trichat:smoke
```

Run deterministic dogfood orchestration check (bridge fanout + turn orchestration + verify finalize):

```bash
npm run trichat:dogfood:smoke
```

Run one internal reliability heartbeat cycle (archived thread, non-user-facing):

```bash
npm run trichat:reliability:run_once
```

Enable background reliability loop at login (optional launchd agent):

```bash
npm run launchd:install:reliability
```

Control the reliability loop agent:

```bash
npm run trichat:reliability:status
npm run trichat:reliability:start
npm run trichat:reliability:stop
```

Run local-imprint arithmetic reliability smoke check:

```bash
npm run imprint:math:smoke
```

Against a live HTTP MCP server:

```bash
TRICHAT_SMOKE_TRANSPORT=http \
MCP_HTTP_BEARER_TOKEN="change-me" \
npm run trichat:smoke
```

## Task Auto Retry

Recommended usage pattern:

1. Use `task.auto_retry` with `action: "status"` to inspect daemon state.
2. Use `task.auto_retry` with `action: "run_once"` for explicit failed-task backoff requeue.
3. Use `task.auto_retry` with `action: "start"` for interval-based retrying.
4. Use `task.timeline` to inspect full event trail for a task id.

Safety defaults:

- `task.auto_retry` only retries tasks currently in `failed` state.
- Backoff is deterministic (`base_delay_seconds * 2^(attempt_count-1)`, capped by `max_delay_seconds`).
- `task.auto_retry` persists daemon state/config, so restart restores previous mode.

## Data Migration

- Copy `data/hub.sqlite` (+ `-wal` / `-shm`) and your `.env`.
- If you use custom `ANAMNESIS_HUB_DB_PATH`, migrate that DB file instead.
- Legacy `MCP_HUB_DB_PATH` is still supported.
