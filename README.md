# Anamnesis
![Tri-Chat Icon](./tri-chat-icon.png)

Anamnesis is a local-first MCP runtime with durable memory, durable task orchestration, and a multi-agent terminal experience (`TriChat`) that lets you talk to `codex`, `cursor`, and `local-imprint` in one place.

## Three Cats, One Apartment
Anamnesis is built as a shared apartment for agents:

- Every agent shares one local identity and one durable context source.
- Raw chat and events land in working memory (`transcript_lines`, `trichat_messages`).
- Important context is squished into long-term memory (`memories`).
- Coordination is deterministic through SQLite, leases, timelines, and idempotent mutation journaling.

Local-first is non-negotiable: everything lives on your machine, centered on `./data/hub.sqlite`.

## What You Get
- Local SQLite persistence (`./data/hub.sqlite` by default)
- Versioned migrations (`schema_migrations` + `PRAGMA user_version`)
- Idempotent side effects (`idempotency_key` + `side_effect_fingerprint`)
- Durable transcript and memory loop (`transcript.log` -> `transcript.squish` -> `memory.search`)
- Auto-squish daemon (`transcript.auto_squish`) + retention (`transcript.retention`)
- Durable tri-agent message bus (`trichat.thread_*`, `trichat.message_post`, `trichat.timeline`)
- Task queue with leases and full event history (`task.*`, `task.timeline`, `task.summary`)
- Retry daemon with deterministic backoff (`task.auto_retry`)
- Adapter circuit breakers with persisted telemetry (`trichat.adapter_telemetry`)
- Imprint continuity (`imprint.profile_set`, `imprint.snapshot`, `imprint.bootstrap`)
- Inbox worker for autonomous execution (`imprint.inbox.*`, `agent_loop.py`)
- ADR support (`adr.create`) writing to `./docs/adrs/` and SQLite

## Quick Start
```bash
npm ci
npm run build
npm run start:stdio
```

In another terminal, launch the Bubble Tea interface:

```bash
npm run trichat:tui
```

HTTP mode is also supported:

```bash
npm run start:http
npm run trichat:tui:http
```

## First Launch Flow (No Slash Commands Required)
When TriChat starts, you get a launcher menu with:

1. `Start Tri-Chat`
2. `Open Reliability`
3. `Open Settings`
4. `Open Help`
5. `Quit`

Then chat naturally. One prompt fans out to all three agents by default. Slash commands stay optional for control cases.

Useful launcher controls:

- `Up/Down`: pick menu item
- `Enter`: launch selection
- `Esc`: skip launcher and jump to chat
- `q`: quit

If you want to disable the launcher:

```bash
npm run trichat:tui -- --no-launcher
```

## One-Click macOS App
Install a clickable app in `~/Applications/TriChat.app` with your icon:

```bash
npm run trichat:app:install -- --icon /absolute/path/to/tri-chat-icon.png
```

Notes:

- Default terminal mode is `alacritty`.
- The installer builds an `.icns` from your PNG and injects it into the app bundle.
- You can copy/move `TriChat.app` into `/Applications` if you want a system-wide launcher.

## TriChat Experience
TriChat TUI gives you:

- Live timeline pane (durable thread history)
- Input bar for natural chat + optional slash commands
- Reliability sidebar (task counts, daemons, lease owners, adapter trips)
- Settings panel for fanout target, gate mode, failover timeouts, and circuit breaker tuning
- Help panel with command reference

Theme direction:

- Cotton-candy cyber palette (pink / blue / mint accents)
- Framed rounded panels for readability
- Fast keyboard-only navigation for live workflows

## Bridge Adapters (Cursor + Codex)
TriChat auto-detects bridge wrappers from `./bridges`:

- `bridges/codex_bridge.py`
- `bridges/cursor_bridge.py`
- `bridges/local-imprint_bridge.py` (optional)

Validate adapters and local auth state:

```bash
npm run trichat:bridges:doctor
```

If needed, authenticate once:

```bash
codex login
cursor-agent login
```

## Reliability Model
The runtime is built to degrade gracefully instead of stalling:

- Per-agent command/model circuit breakers
- Recovery windows and auto-close behavior
- Durable breaker state + trip history in SQLite
- Automatic retry for failed tasks with backoff
- Lease-based task claiming with heartbeat support
- Message retention daemons to keep growth bounded

## Core Operational Commands
Health and checks:

```bash
npm test
npm run mvp:smoke
npm run trichat:smoke
```

Agent lifecycle:

```bash
npm run agents:on
npm run agents:off
npm run agents:status
```

Launchd services:

```bash
npm run launchd:install
npm run launchd:uninstall
```

Imprint continuity:

```bash
npm run imprint:bootstrap
python3 ./agent_loop.py --help
```

Inbox queue:

```bash
npm run inbox:enqueue -- --objective "Run tests and summarize failures"
npm run inbox:worker
```

## High-Value MCP Tools
Memory and transcripts:

- `memory.append`
- `memory.search`
- `memory.get`
- `transcript.log`
- `transcript.run_timeline`
- `transcript.squish`
- `transcript.auto_squish`
- `transcript.retention`

Knowledge and governance:

- `knowledge.promote` (`source_type`: `memory` or `transcript_line`)
- `adr.create`
- `migration.status`

TriChat bus and telemetry:

- `trichat.thread_open`
- `trichat.thread_list`
- `trichat.thread_get`
- `trichat.message_post`
- `trichat.timeline`
- `trichat.summary`
- `trichat.retention`
- `trichat.auto_retention`
- `trichat.adapter_telemetry`

Tasks and execution:

- `task.create`
- `task.list`
- `task.claim`
- `task.heartbeat`
- `task.complete`
- `task.fail`
- `task.retry`
- `task.timeline`
- `task.summary`
- `task.auto_retry`

## Configuration
Copy env template:

```bash
cp .env.example .env
```

Key env vars:

- `ANAMNESIS_HUB_DB_PATH` (preferred, default `./data/hub.sqlite`)
- `MCP_HUB_DB_PATH` (legacy fallback)
- `MCP_HTTP_BEARER_TOKEN`
- `MCP_HTTP_ALLOWED_ORIGINS`
- `TRICHAT_MCP_TRANSPORT` (`stdio` or `http`)
- `TRICHAT_OLLAMA_MODEL`
- `TRICHAT_TUI_LAUNCHER` (`true`/`false`)
- `TRICHAT_EXECUTE_GATE_MODE` (`open`/`allowlist`/`approval`)

## Suggested Daily Loop
1. Start server + TriChat.
2. Chat naturally; let prompts fan out to all agents.
3. Route concrete actions into durable tasks.
4. Watch reliability sidebar for leases, retries, and adapter events.
5. Periodically squish and retain old working memory.
6. Snapshot imprint context before handoff.

## Repo Layout
- `src/` TypeScript MCP server
- `cmd/trichat-tui/` Bubble Tea terminal UI
- `bridges/` Codex/Cursor/local adapter wrappers
- `scripts/` smoke checks, installers, launch helpers
- `docs/` architecture notes and ADRs
- `data/` local SQLite DB and runtime state
- `tests/` integration and invariants

## Transport Docs
- STDIO: `npm run start:stdio`
- HTTP: `npm run start:http`

More connection examples: `./docs/CONNECT.md`
