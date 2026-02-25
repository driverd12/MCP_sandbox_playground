# Anamnesis

Anamnesis is a local-first MCP server for cross-IDE continuity, durable memory, run ledgers, policy checks, locks, incident timelines, and deterministic workflow simulation.

## Vision

Anamnesis is designed as a "Shared Apartment" for agents. Different clients and IDEs can enter the same local runtime, retain shared identity, and coordinate through durable memory rather than ephemeral chat logs. Raw interactions land in working memory (`transcript_lines`), then are squished into distilled long-term memory (`memories`) so context stays useful instead of growing without bound.

## Features

- Local SQLite storage (`./data/hub.sqlite` by default)
- Versioned SQLite migrations with `schema_migrations` + `PRAGMA user_version`
- Idempotent mutation journal (`idempotency_key` + `side_effect_fingerprint`)
- Shared memory and transcript tooling across clients
- Transcript squishing loop (`transcript.log` -> `transcript.squish` -> `memory.search`)
- Interval backlog drain daemon (`transcript.auto_squish`)
- Auto-squish daemon config persisted across server restarts
- Retention policy control for transcript working memory (`transcript.retention`)
- Durable Imprint profile + continuity snapshots (`imprint.profile_set`, `imprint.snapshot`, `imprint.bootstrap`)
- Interval-based Imprint snapshot daemon (`imprint.auto_snapshot`)
- Local inbox queue + worker daemon for unprompted workload execution (`data/imprint/inbox`, `imprint.inbox.enqueue`)
- Durable task orchestration with leases (`tasks`, `task_events`, `task_leases`, `task.*`)
- Task reliability summary surface (`task.summary`) for live queue/lease visibility
- Failed-task retry daemon with deterministic backoff (`task.auto_retry`)
- Durable tri-chat message bus (`trichat.thread_*`, `trichat.message_post`, `trichat.timeline`)
- Tri-chat retention controls to keep message history bounded (`trichat.retention`)
- Launchd auto-start support for MCP HTTP server + Imprint auto-snapshot
- Agent on/off switch (`scripts/agents_switch.sh`) for start/stop/status control
- ADR creation helper (`adr.create`) writing to `./docs/adrs/`
- Policy/preflight/postflight safety tools
- Run timeline ledgering + lock leasing
- Local retrieval and query planning
- Incident tracking and timeline

## Quick Start

```bash
npm ci
npm run build
npm run start:stdio
```

Start TriChat (STDIO-backed MCP calls):

```bash
npm run trichat
```

Start TriChat against a live local HTTP MCP server:

```bash
npm run start:http
npm run trichat:http
```

## Configuration

Copy and edit:

```bash
cp .env.example .env
```

Key env vars:

- `ANAMNESIS_HUB_DB_PATH` (preferred, default `./data/hub.sqlite`)
- `MCP_HUB_DB_PATH` (legacy fallback)
- `MCP_HTTP_BEARER_TOKEN`
- `MCP_HTTP_ALLOWED_ORIGINS`
- `ANAMNESIS_INBOX_POLL_INTERVAL` / `ANAMNESIS_INBOX_BATCH_SIZE`
- `ANAMNESIS_INBOX_LEASE_SECONDS` / `ANAMNESIS_INBOX_HEARTBEAT_INTERVAL`

## Test

```bash
npm test
```

## MVP Workflow

1. Log raw lines into working memory with `transcript.log`.
2. Squish unsquished lines by run/session using `transcript.squish`.
3. Query distilled results through `memory.search`, `who_knows`, or `retrieval.hybrid`.
4. Persist architecture decisions with `adr.create`.
5. Periodically drain and prune with `transcript.auto_squish` and `transcript.retention`.

This loop is fully local-first and idempotent for mutating tools.
Run the baseline smoke check with `npm run mvp:smoke`.

## Imprint Continuity

Bootstrap a durable local profile + snapshot in one command:

```bash
npm run imprint:bootstrap
```

This runs `imprint.profile_set`, `imprint.snapshot`, and `imprint.bootstrap` against your live server transport (`stdio` by default).

`agent_loop.py` now loads `imprint.bootstrap` at startup by default, so local Llama planning starts from persisted context.
Disable it with `--no-imprint-bootstrap`.

## Inbox Worker

Drop a task into local inbox:

```bash
npm run inbox:enqueue -- --objective "Run tests and summarize failures"
```

Run worker manually:

```bash
npm run inbox:worker
```

Worker behavior:

- Claims durable tasks from SQLite with renewable leases.
- Imports legacy file drops from `./data/imprint/inbox/pending` into durable tasks.
- Archives execution payloads/results in `done` and `failed` for human debugging.

Inbox paths:

- `./data/imprint/inbox/pending` (new tasks)
- `./data/imprint/inbox/processing` (legacy import staging)
- `./data/imprint/inbox/done` (completed task + result JSON)
- `./data/imprint/inbox/failed` (failed task + result JSON)

## Always-On Mode

Install launchd services (auto-start on login):

```bash
npm run launchd:install
```

Control local agent switches:

```bash
npm run agents:on
npm run agents:off
npm run agents:status
```

Switch mapping:

- `eyes`: local MCP server context visibility
- `ears`: local MCP intake/transport availability
- `fingers`: local automated agent execution capability

## Agent Playbook

- Use `transcript.pending_runs` to discover runs that still need squishing.
- Use `transcript.run_timeline` for deterministic debugging of a single run.
- Use `transcript.auto_squish` in `status`, `run_once`, `start`, and `stop` modes to automate backlog draining.
- Use `transcript.retention` with `dry_run: true` first, then apply deletion once candidates are verified.
- Use `migration.status` to confirm applied schema versions independently of health checks.
- Use `memory.get` to inspect exact long-term records by id when triaging behavior.
- Use `knowledge.promote` with `source_type` set to `memory` or `transcript_line` to elevate proven details.
- Use `imprint.profile_set` once per project/workspace to persist operating doctrine for all future agents.
- Use `imprint.snapshot` before handoff to persist current local state as a continuity checkpoint.
- Use `imprint.bootstrap` at session start to rehydrate mission, recent memory, and pending work in one read.
- Use `imprint.auto_snapshot` (`status`, `run_once`, `start`, `stop`) for periodic continuity capture.
- Use `imprint.inbox.enqueue` (or `npm run inbox:enqueue`) to submit background workloads.
- Use `imprint.inbox.list` to inspect backlog and task outcomes.
- Use `task.create`, `task.list`, and `task.claim` for durable queue orchestration.
- Use `task.summary` for live reliability counts, running lease owners, and latest failure context.
- Use `task.timeline` to inspect the exact event trail in `task_events`.
- Use `task.heartbeat`, `task.complete`, `task.fail`, and `task.retry` for lease-aware lifecycle control.
- Use `task.auto_retry` (`status`, `run_once`, `start`, `stop`) to requeue failed tasks with backoff.
- Use `trichat.thread_open` / `trichat.thread_list` / `trichat.thread_get` to manage persistent tri-chat threads.
- Use `trichat.message_post` and `trichat.timeline` to keep user/agent conversation state durable across restarts.
- Use `trichat.retention` (`dry_run` first) to prune old message-bus history when threads grow large.
- Run `./scripts/mvp_smoke.sh` before handoff to verify end-to-end health (default `stdio`, optional `http`).

## TriChat

TriChat provides one terminal orchestrator that fans one prompt out to `codex`, `cursor`, and `local-imprint`, writes every turn into the durable message bus, and routes execution into durable tasks.

Run:

```bash
python3 ./scripts/trichat.py --resume-latest --panel-on-start
```

Bridge mode (optional):

- Set `TRICHAT_CODEX_CMD` and/or `TRICHAT_CURSOR_CMD` to command adapters that read JSON from stdin and print response text or `{"content":"..."}` JSON.
- If bridge commands are not configured (or fail), TriChat falls back to local Ollama adapters so all three channels continue responding.

Useful commands in TriChat:

- `/plan`, `/propose`, `/agent <id> <msg>`, `/huddle <topic>`
- `/execute <agent> [objective]` (routes into `task.create`)
- `/gate status|open|allowlist|approval`
- `/gate allowlist <agent1,agent2,...>`
- `/gate phrase <text>` (approval mode phrase)
- `/panel`, `/tasks`, `/timeline <task_id>`, `/retry ...`
- `/thread list|new|use|archive`
- `/retention [days] [apply] [all]`

`/execute` policy modes:

- `open` (default): fully unconstrained routing to `task.create`.
- `allowlist`: only allow `/execute` from configured agent IDs.
- `approval`: require interactive operator confirmation before `task.create`.

Configure gate mode at startup:

```bash
python3 ./scripts/trichat.py --execute-gate-mode open
python3 ./scripts/trichat.py --execute-gate-mode allowlist --execute-allow-agents codex,local-imprint
python3 ./scripts/trichat.py --execute-gate-mode approval --execute-approval-phrase approve
```

TriChat operational smoke check:

```bash
npm run trichat:smoke
```

Run smoke against a live local HTTP server:

```bash
TRICHAT_SMOKE_TRANSPORT=http \
MCP_HTTP_BEARER_TOKEN="change-me" \
npm run trichat:smoke
```

Suggested loop for multi-agent collaboration:

1. Agent A logs raw observations with `transcript.log`.
2. Agent B runs `transcript.auto_squish` (`run_once` or daemon `start`) and checks `transcript.pending_runs` until backlog is clear.
3. Agent C searches with `retrieval.hybrid`, validates with `memory.get`, and promotes high-value items.
4. Agent D applies `transcript.retention` after a `dry_run` review to keep raw backlog bounded.
5. Any agent records decisions via `adr.create` for durable governance.

## Transports

- STDIO: `npm run start:stdio`
- HTTP: `npm run start:http`

See `/docs/CONNECT.md` for full setup and client examples.
