# MCP Sandbox Playground

A local-first MCP server for cross-IDE continuity, durable notes/transcripts, run ledgers, policy checks, locks, incident timelines, and deterministic workflow simulation.

## Features

- Local SQLite storage (`./data/hub.sqlite` by default)
- Idempotent mutation journal (`idempotency_key` + `side_effect_fingerprint`)
- Shared memory/transcript tools across clients
- ADR creation helper (`adr.create`)
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

- `MCP_HUB_DB_PATH` (default `./data/hub.sqlite`)
- `MCP_HTTP_BEARER_TOKEN`
- `MCP_HTTP_ALLOWED_ORIGINS`

## Test

```bash
npm test
```

## Transports

- STDIO: `npm run start:stdio`
- HTTP: `npm run start:http`

See `/docs/CONNECT.md` for full setup and client examples.
