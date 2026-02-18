# Anamnesis

Anamnesis is a local-first MCP server for cross-IDE continuity, durable memory, run ledgers, policy checks, locks, incident timelines, and deterministic workflow simulation.

## Vision

Anamnesis is designed as a "Shared Apartment" for agents. Different clients and IDEs can enter the same local runtime, retain shared identity, and coordinate through durable memory rather than ephemeral chat logs. Raw interactions land in working memory (`transcript_lines`), then are squished into distilled long-term memory (`memories`) so context stays useful instead of growing without bound.

## Features

- Local SQLite storage (`./data/hub.sqlite` by default)
- Idempotent mutation journal (`idempotency_key` + `side_effect_fingerprint`)
- Shared memory and transcript tooling across clients
- Transcript squishing loop (`transcript.log` -> `transcript.squish` -> `memory.search`)
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

This loop is fully local-first and idempotent for mutating tools.

## Transports

- STDIO: `npm run start:stdio`
- HTTP: `npm run start:http`

See `/docs/CONNECT.md` for full setup and client examples.
