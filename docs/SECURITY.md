# MCP Sandbox Playground Security

## Scope

- Local-first server with SQLite persistence in `./data/hub.sqlite`.
- STDIO transport has no network surface.
- HTTP transport is bound to loopback only.

## HTTP Guardrails

- Requires `Authorization: Bearer <token>` with `MCP_HTTP_BEARER_TOKEN`.
- Validates `Origin` against `MCP_HTTP_ALLOWED_ORIGINS`.
- Rejects requests with invalid or missing Origin or token using HTTP 403.
- Does not bind to `0.0.0.0`.

## Data Handling

- Uses SQLite WAL mode for durability.
- Logs are emitted to stderr only.
- No secrets are persisted to disk by default.
- Mutating MCP tools are journaled with idempotency metadata (`idempotency_key` + `side_effect_fingerprint`).
- Policy evaluations, run events, and incident timelines are persisted for auditability.

## External Providers

- Provider-backed consultation is disabled in local-only mode.
- Continuity capture and query workflows run on local SQLite data only.
- If provider tools are re-enabled in future, treat them as explicit opt-in and document the data boundary.
