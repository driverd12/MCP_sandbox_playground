#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCH_DIR="${HOME}/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"

MCP_LABEL="com.anamnesis.mcp.server"
AUTO_LABEL="com.anamnesis.imprint.autosnapshot"

MCP_PLIST="${LAUNCH_DIR}/${MCP_LABEL}.plist"
AUTO_PLIST="${LAUNCH_DIR}/${AUTO_LABEL}.plist"

"${REPO_ROOT}/scripts/imprint_auto_snapshot_ctl.sh" stop >/dev/null 2>&1 || true

if [[ -f "${MCP_PLIST}" ]]; then
  launchctl bootout "${DOMAIN}" "${MCP_PLIST}" >/dev/null 2>&1 || true
  launchctl disable "${DOMAIN}/${MCP_LABEL}" >/dev/null 2>&1 || true
  rm -f "${MCP_PLIST}"
fi

if [[ -f "${AUTO_PLIST}" ]]; then
  launchctl bootout "${DOMAIN}" "${AUTO_PLIST}" >/dev/null 2>&1 || true
  launchctl disable "${DOMAIN}/${AUTO_LABEL}" >/dev/null 2>&1 || true
  rm -f "${AUTO_PLIST}"
fi

echo "{\"ok\":true,\"removed\":[\"${MCP_LABEL}\",\"${AUTO_LABEL}\"]}" >&2
