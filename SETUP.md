# Anamnesis Setup Instructions:

This is the fastest path to run Anamnesis locally.

## 1. Prereqs

- Node.js `22.x` (recommended)
- `git`

Optional (recommended):

- GitHub CLI `gh` for auth and cloning private repos

## 2. Clone

```bash
git clone https://github.com/driverd12/MCP_sandbox_playground.git
cd MCP_sandbox_playground
```

## 3. Install + Build

```bash
npm ci
npm run build
```

## 4. Configure Local Env

```bash
cp .env.example .env
```

Minimal `.env` values:

```bash
ANAMNESIS_HUB_DB_PATH=./data/hub.sqlite
# MCP_HUB_DB_PATH=./data/hub.sqlite
MCP_HTTP_BEARER_TOKEN=change-me
MCP_HTTP_ALLOWED_ORIGINS=http://localhost,http://127.0.0.1
```

## 5. Verify

```bash
npm test
```

Expected result: all tests pass.

## 6. Start Server

STDIO (default, best for IDE MCP):

```bash
npm run start:stdio
```

HTTP (optional local API mode):

```bash
npm run start:http
```

## 7. IDE MCP Command

Point your MCP client to:

```bash
node /absolute/path/to/MCP_sandbox_playground/dist/server.js
```

Example (macOS path): (not limited to just cursor, just where mine lives.)

```bash
node /Users/<you>/Cursor_projects/python/MCP_sandbox_playground/dist/server.js
```

## Troubleshooting

- `Cannot find module ...`: run `npm ci` again.
- Build errors after Node upgrade: switch back to Node 22 and rerun `npm ci`.
- Empty tools list in client: confirm client points at `dist/server.js` from this repo, then restart client.
