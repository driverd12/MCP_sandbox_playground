#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCH_DIR="${HOME}/Library/LaunchAgents"
LOG_DIR="${REPO_ROOT}/data/imprint/logs"
DOMAIN="gui/$(id -u)"

MCP_LABEL="com.anamnesis.mcp.server"
AUTO_LABEL="com.anamnesis.imprint.autosnapshot"
WORKER_LABEL="com.anamnesis.imprint.inboxworker"
RELIABILITY_LABEL="com.anamnesis.trichat.reliabilityloop"

MCP_PLIST="${LAUNCH_DIR}/${MCP_LABEL}.plist"
AUTO_PLIST="${LAUNCH_DIR}/${AUTO_LABEL}.plist"
WORKER_PLIST="${LAUNCH_DIR}/${WORKER_LABEL}.plist"
RELIABILITY_PLIST="${LAUNCH_DIR}/${RELIABILITY_LABEL}.plist"

MCP_PORT="${ANAMNESIS_MCP_HTTP_PORT:-8787}"
ALLOWED_ORIGINS="${MCP_HTTP_ALLOWED_ORIGINS:-http://localhost,http://127.0.0.1}"
INBOX_POLL_INTERVAL="${ANAMNESIS_INBOX_POLL_INTERVAL:-5}"
INBOX_BATCH_SIZE="${ANAMNESIS_INBOX_BATCH_SIZE:-3}"
INBOX_LEASE_SECONDS="${ANAMNESIS_INBOX_LEASE_SECONDS:-300}"
INBOX_HEARTBEAT_INTERVAL="${ANAMNESIS_INBOX_HEARTBEAT_INTERVAL:-30}"
RELIABILITY_LOOP_ENABLED="${ANAMNESIS_TRICHAT_RELIABILITY_LOOP_ENABLED:-false}"
RELIABILITY_INTERVAL_SECONDS="${ANAMNESIS_TRICHAT_RELIABILITY_INTERVAL_SECONDS:-300}"
RELIABILITY_THREAD_ID="${ANAMNESIS_TRICHAT_RELIABILITY_THREAD_ID:-trichat-reliability-internal}"
RELIABILITY_AGENTS="${ANAMNESIS_TRICHAT_RELIABILITY_AGENTS:-codex,cursor,local-imprint}"
RELIABILITY_DRY_RUN="${ANAMNESIS_TRICHAT_RELIABILITY_DRY_RUN:-true}"
RELIABILITY_EXECUTE="${ANAMNESIS_TRICHAT_RELIABILITY_EXECUTE:-false}"
RELIABILITY_REQUIRE_SUCCESS_AGENTS="${ANAMNESIS_TRICHAT_RELIABILITY_REQUIRE_SUCCESS_AGENTS:-0}"
RELIABILITY_BRIDGE_TIMEOUT="${ANAMNESIS_TRICHAT_RELIABILITY_BRIDGE_TIMEOUT:-180}"
RELIABILITY_RETENTION_DAYS="${ANAMNESIS_TRICHAT_RELIABILITY_RETENTION_DAYS:-3}"
RELIABILITY_RETENTION_LIMIT="${ANAMNESIS_TRICHAT_RELIABILITY_RETENTION_LIMIT:-2000}"
NODE_BIN="$(command -v node || true)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "error: node not found in PATH" >&2
  exit 2
fi
PYTHON_BIN="$(command -v python3 || true)"
if [[ -z "${PYTHON_BIN}" ]]; then
  echo "error: python3 not found in PATH" >&2
  exit 2
fi

parse_bool() {
  local value="${1:-}"
  local fallback="${2:-false}"
  local normalized
  normalized="$(printf '%s' "${value}" | tr '[:upper:]' '[:lower:]')"
  case "${normalized}" in
    1|true|yes|on) echo "true" ;;
    0|false|no|off) echo "false" ;;
    *) echo "${fallback}" ;;
  esac
}

parse_int() {
  local value="${1:-}"
  local fallback="${2:-0}"
  if [[ "${value}" =~ ^[0-9]+$ ]]; then
    echo "${value}"
    return
  fi
  echo "${fallback}"
}

RELIABILITY_LOOP_ENABLED="$(parse_bool "${RELIABILITY_LOOP_ENABLED}" "false")"
RELIABILITY_DRY_RUN="$(parse_bool "${RELIABILITY_DRY_RUN}" "true")"
RELIABILITY_EXECUTE="$(parse_bool "${RELIABILITY_EXECUTE}" "false")"
RELIABILITY_INTERVAL_SECONDS="$(parse_int "${RELIABILITY_INTERVAL_SECONDS}" "300")"
RELIABILITY_REQUIRE_SUCCESS_AGENTS="$(parse_int "${RELIABILITY_REQUIRE_SUCCESS_AGENTS}" "0")"
RELIABILITY_BRIDGE_TIMEOUT="$(parse_int "${RELIABILITY_BRIDGE_TIMEOUT}" "180")"
RELIABILITY_RETENTION_DAYS="$(parse_int "${RELIABILITY_RETENTION_DAYS}" "3")"
RELIABILITY_RETENTION_LIMIT="$(parse_int "${RELIABILITY_RETENTION_LIMIT}" "2000")"

TOKEN_FILE="${REPO_ROOT}/data/imprint/http_bearer_token"
HTTP_BEARER_TOKEN="${MCP_HTTP_BEARER_TOKEN:-${ANAMNESIS_MCP_HTTP_BEARER_TOKEN:-}}"
if [[ -z "${HTTP_BEARER_TOKEN}" && -f "${TOKEN_FILE}" ]]; then
  HTTP_BEARER_TOKEN="$(cat "${TOKEN_FILE}")"
fi
if [[ -z "${HTTP_BEARER_TOKEN}" ]]; then
  HTTP_BEARER_TOKEN="$(${PYTHON_BIN} - <<'PY'
import secrets
print(secrets.token_hex(24))
PY
)"
fi
mkdir -p "$(dirname "${TOKEN_FILE}")"
printf '%s' "${HTTP_BEARER_TOKEN}" > "${TOKEN_FILE}"
chmod 600 "${TOKEN_FILE}" >/dev/null 2>&1 || true

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
      <key>MCP_HTTP_ALLOWED_ORIGINS</key>
      <string>${ALLOWED_ORIGINS}</string>
      <key>MCP_HTTP_BEARER_TOKEN</key>
      <string>${HTTP_BEARER_TOKEN}</string>
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

cat >"${WORKER_PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${WORKER_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
      <string>${PYTHON_BIN}</string>
      <string>${REPO_ROOT}/scripts/imprint_inbox_worker.py</string>
      <string>--repo-root</string>
      <string>${REPO_ROOT}</string>
      <string>--poll-interval</string>
      <string>${INBOX_POLL_INTERVAL}</string>
      <string>--batch-size</string>
      <string>${INBOX_BATCH_SIZE}</string>
      <string>--lease-seconds</string>
      <string>${INBOX_LEASE_SECONDS}</string>
      <string>--heartbeat-interval</string>
      <string>${INBOX_HEARTBEAT_INTERVAL}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${REPO_ROOT}</string>

    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${PATH}</string>
      <key>PYTHONUNBUFFERED</key>
      <string>1</string>
      <key>ANAMNESIS_IMPRINT_PROFILE_ID</key>
      <string>${ANAMNESIS_IMPRINT_PROFILE_ID:-default}</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/inbox-worker.out.log</string>

    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/inbox-worker.err.log</string>
  </dict>
</plist>
PLIST

if [[ "${RELIABILITY_LOOP_ENABLED}" == "true" ]]; then
cat >"${RELIABILITY_PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${RELIABILITY_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
      <string>/bin/zsh</string>
      <string>-lc</string>
      <string>cd ${REPO_ROOT} &amp;&amp; ./scripts/trichat_reliability_run_once.sh</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${REPO_ROOT}</string>

    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${PATH}</string>
      <key>ANAMNESIS_TRICHAT_RELIABILITY_THREAD_ID</key>
      <string>${RELIABILITY_THREAD_ID}</string>
      <key>ANAMNESIS_TRICHAT_RELIABILITY_AGENTS</key>
      <string>${RELIABILITY_AGENTS}</string>
      <key>ANAMNESIS_TRICHAT_RELIABILITY_DRY_RUN</key>
      <string>${RELIABILITY_DRY_RUN}</string>
      <key>ANAMNESIS_TRICHAT_RELIABILITY_EXECUTE</key>
      <string>${RELIABILITY_EXECUTE}</string>
      <key>ANAMNESIS_TRICHAT_RELIABILITY_REQUIRE_SUCCESS_AGENTS</key>
      <string>${RELIABILITY_REQUIRE_SUCCESS_AGENTS}</string>
      <key>ANAMNESIS_TRICHAT_RELIABILITY_BRIDGE_TIMEOUT</key>
      <string>${RELIABILITY_BRIDGE_TIMEOUT}</string>
      <key>ANAMNESIS_TRICHAT_RELIABILITY_RETENTION_DAYS</key>
      <string>${RELIABILITY_RETENTION_DAYS}</string>
      <key>ANAMNESIS_TRICHAT_RELIABILITY_RETENTION_LIMIT</key>
      <string>${RELIABILITY_RETENTION_LIMIT}</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>StartInterval</key>
    <integer>${RELIABILITY_INTERVAL_SECONDS}</integer>

    <key>KeepAlive</key>
    <false/>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/trichat-reliability.out.log</string>

    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/trichat-reliability.err.log</string>
  </dict>
</plist>
PLIST
else
  launchctl bootout "${DOMAIN}" "${RELIABILITY_PLIST}" >/dev/null 2>&1 || true
  launchctl disable "${DOMAIN}/${RELIABILITY_LABEL}" >/dev/null 2>&1 || true
  rm -f "${RELIABILITY_PLIST}"
fi

chmod 644 "${MCP_PLIST}" "${AUTO_PLIST}" "${WORKER_PLIST}"
if [[ -f "${RELIABILITY_PLIST}" ]]; then
  chmod 644 "${RELIABILITY_PLIST}"
fi

cd "${REPO_ROOT}"
npm run build >/dev/null

launchctl bootout "${DOMAIN}" "${MCP_PLIST}" >/dev/null 2>&1 || true
launchctl bootout "${DOMAIN}" "${AUTO_PLIST}" >/dev/null 2>&1 || true
launchctl bootout "${DOMAIN}" "${WORKER_PLIST}" >/dev/null 2>&1 || true
launchctl bootout "${DOMAIN}" "${RELIABILITY_PLIST}" >/dev/null 2>&1 || true

launchctl bootstrap "${DOMAIN}" "${MCP_PLIST}"
launchctl bootstrap "${DOMAIN}" "${AUTO_PLIST}"
launchctl bootstrap "${DOMAIN}" "${WORKER_PLIST}"
if [[ -f "${RELIABILITY_PLIST}" ]]; then
  launchctl bootstrap "${DOMAIN}" "${RELIABILITY_PLIST}"
fi

launchctl enable "${DOMAIN}/${MCP_LABEL}" >/dev/null 2>&1 || true
launchctl enable "${DOMAIN}/${AUTO_LABEL}" >/dev/null 2>&1 || true
launchctl enable "${DOMAIN}/${WORKER_LABEL}" >/dev/null 2>&1 || true
if [[ -f "${RELIABILITY_PLIST}" ]]; then
  launchctl enable "${DOMAIN}/${RELIABILITY_LABEL}" >/dev/null 2>&1 || true
fi
launchctl kickstart -k "${DOMAIN}/${MCP_LABEL}" >/dev/null 2>&1 || true
launchctl kickstart -k "${DOMAIN}/${AUTO_LABEL}" >/dev/null 2>&1 || true
launchctl kickstart -k "${DOMAIN}/${WORKER_LABEL}" >/dev/null 2>&1 || true
if [[ -f "${RELIABILITY_PLIST}" ]]; then
  launchctl kickstart -k "${DOMAIN}/${RELIABILITY_LABEL}" >/dev/null 2>&1 || true
fi

for _ in 1 2 3 4 5; do
  if "${REPO_ROOT}/scripts/imprint_auto_snapshot_ctl.sh" start >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo "Installed launchd agents:" >&2
echo "- ${MCP_PLIST}" >&2
echo "- ${AUTO_PLIST}" >&2
echo "- ${WORKER_PLIST}" >&2
if [[ -f "${RELIABILITY_PLIST}" ]]; then
  echo "- ${RELIABILITY_PLIST}" >&2
fi

echo "{" >&2
echo "  \"ok\": true," >&2
echo "  \"domain\": \"${DOMAIN}\"," >&2
echo "  \"mcp_label\": \"${MCP_LABEL}\"," >&2
echo "  \"auto_snapshot_label\": \"${AUTO_LABEL}\"," >&2
echo "  \"worker_label\": \"${WORKER_LABEL}\"," >&2
echo "  \"reliability_loop_enabled\": ${RELIABILITY_LOOP_ENABLED}," >&2
echo "  \"reliability_label\": \"${RELIABILITY_LABEL}\"," >&2
echo "  \"mcp_port\": ${MCP_PORT}," >&2
echo "  \"http_token_file\": \"${TOKEN_FILE}\"" >&2
echo "}" >&2
