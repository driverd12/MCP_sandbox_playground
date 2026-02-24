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
- `imprint.profile_set`, `imprint.profile_get`, `imprint.snapshot`, `imprint.bootstrap`, `imprint.auto_snapshot`
- `transcript.log`, `transcript.auto_squish`, `transcript.pending_runs`, `transcript.retention`, `transcript.run_timeline`, `transcript.squish`, `transcript.append`, `transcript.summarize`
- `adr.create`
- `who_knows`, `knowledge.query`
- `policy.evaluate`
- `run.begin`, `run.step`, `run.end`, `run.timeline`
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

Install login-time services for local MCP HTTP and imprint auto-snapshot:

```bash
npm run launchd:install
```

Toggle runtime switches:

```bash
npm run agents:on
npm run agents:off
npm run agents:status
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

## Data Migration

- Copy `data/hub.sqlite` (+ `-wal` / `-shm`) and your `.env`.
- If you use custom `ANAMNESIS_HUB_DB_PATH`, migrate that DB file instead.
- Legacy `MCP_HUB_DB_PATH` is still supported.
