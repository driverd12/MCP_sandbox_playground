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

## Agent Playbook

- Use `transcript.pending_runs` to discover runs that still need squishing.
- Use `transcript.run_timeline` for deterministic debugging of a single run.
- Use `transcript.auto_squish` in `status`, `run_once`, `start`, and `stop` modes to automate backlog draining.
- Use `transcript.retention` with `dry_run: true` first, then apply deletion once candidates are verified.
- Use `migration.status` to confirm applied schema versions independently of health checks.
- Use `memory.get` to inspect exact long-term records by id when triaging behavior.
- Use `knowledge.promote` with `source_type` set to `memory` or `transcript_line` to elevate proven details.
- Run `./scripts/mvp_smoke.sh` before handoff to verify end-to-end health (default `stdio`, optional `http`).

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
