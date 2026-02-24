#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCH_DIR="${HOME}/Library/LaunchAgents"
LOG_DIR="${REPO_ROOT}/data/imprint/logs"
DOMAIN="gui/$(id -u)"

MCP_LABEL="com.anamnesis.mcp.server"
AUTO_LABEL="com.anamnesis.imprint.autosnapshot"

MCP_PLIST="${LAUNCH_DIR}/${MCP_LABEL}.plist"
AUTO_PLIST="${LAUNCH_DIR}/${AUTO_LABEL}.plist"

MCP_PORT="${ANAMNESIS_MCP_HTTP_PORT:-8787}"
NODE_BIN="$(command -v node || true)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "error: node not found in PATH" >&2
  exit 2
fi

mkdir -p "${LAUNCH_DIR}" "${LOG_DIR}"

cat >"${MCP_PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${MCP_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
      <string>${NODE_BIN}</string>
      <string>${REPO_ROOT}/dist/server.js</string>
      <string>--http</string>
      <string>--http-port</string>
      <string>${MCP_PORT}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${REPO_ROOT}</string>

    <key>EnvironmentVariables</key>
    <dict>
      <key>MCP_HTTP</key>
      <string>1</string>
      <key>MCP_HTTP_HOST</key>
      <string>127.0.0.1</string>
      <key>MCP_HTTP_PORT</key>
      <string>${MCP_PORT}</string>
      <key>PATH</key>
      <string>${PATH}</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/mcp-http.out.log</string>

    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/mcp-http.err.log</string>
  </dict>
</plist>
PLIST

cat >"${AUTO_PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${AUTO_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
      <string>/bin/zsh</string>
      <string>-lc</string>
      <string>cd ${REPO_ROOT} &amp;&amp; ./scripts/imprint_auto_snapshot_ctl.sh start</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${REPO_ROOT}</string>

    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${PATH}</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <false/>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/imprint-auto.out.log</string>

    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/imprint-auto.err.log</string>
  </dict>
</plist>
PLIST

chmod 644 "${MCP_PLIST}" "${AUTO_PLIST}"

cd "${REPO_ROOT}"
npm run build >/dev/null

launchctl bootout "${DOMAIN}" "${MCP_PLIST}" >/dev/null 2>&1 || true
launchctl bootout "${DOMAIN}" "${AUTO_PLIST}" >/dev/null 2>&1 || true

launchctl bootstrap "${DOMAIN}" "${MCP_PLIST}"
launchctl bootstrap "${DOMAIN}" "${AUTO_PLIST}"

launchctl enable "${DOMAIN}/${MCP_LABEL}" >/dev/null 2>&1 || true
launchctl enable "${DOMAIN}/${AUTO_LABEL}" >/dev/null 2>&1 || true
launchctl kickstart -k "${DOMAIN}/${MCP_LABEL}" >/dev/null 2>&1 || true
launchctl kickstart -k "${DOMAIN}/${AUTO_LABEL}" >/dev/null 2>&1 || true

echo "Installed launchd agents:" >&2
echo "- ${MCP_PLIST}" >&2
echo "- ${AUTO_PLIST}" >&2

echo "{" >&2
echo "  \"ok\": true," >&2
echo "  \"domain\": \"${DOMAIN}\"," >&2
echo "  \"mcp_label\": \"${MCP_LABEL}\"," >&2
echo "  \"auto_snapshot_label\": \"${AUTO_LABEL}\"," >&2
echo "  \"mcp_port\": ${MCP_PORT}" >&2
echo "}" >&2
