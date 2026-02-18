# MCP Sandbox Playground Connect

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
- Override DB path with `MCP_HUB_DB_PATH=/absolute/path/to/hub.sqlite`.

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
MCP_HUB_DB_PATH=./data/hub.sqlite
MCP_HTTP_BEARER_TOKEN=change-me
MCP_HTTP_ALLOWED_ORIGINS=http://localhost,http://127.0.0.1
```

## Validation

Run full local integration suite:

```bash
npm test
```

## Tool Set

- `memory.append`, `memory.search`
- `transcript.append`, `transcript.summarize`
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

## Data Migration

- Copy `data/hub.sqlite` (+ `-wal` / `-shm`) and your `.env`.
- If you use custom `MCP_HUB_DB_PATH`, migrate that DB file instead.
