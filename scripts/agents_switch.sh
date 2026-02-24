#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-status}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCH_DIR="${HOME}/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"

MCP_LABEL="com.anamnesis.mcp.server"
AUTO_LABEL="com.anamnesis.imprint.autosnapshot"
MCP_PLIST="${LAUNCH_DIR}/${MCP_LABEL}.plist"
AUTO_PLIST="${LAUNCH_DIR}/${AUTO_LABEL}.plist"

is_loaded() {
  local label="$1"
  launchctl print "${DOMAIN}/${label}" >/dev/null 2>&1
}

bootout_if_exists() {
  local plist="$1"
  if [[ -f "${plist}" ]]; then
    launchctl bootout "${DOMAIN}" "${plist}" >/dev/null 2>&1 || true
  fi
}

bootstrap_if_exists() {
  local plist="$1"
  if [[ -f "${plist}" ]]; then
    launchctl bootstrap "${DOMAIN}" "${plist}" >/dev/null 2>&1 || true
  fi
}

case "${ACTION}" in
  on)
    if [[ ! -f "${MCP_PLIST}" || ! -f "${AUTO_PLIST}" ]]; then
      "${REPO_ROOT}/scripts/launchd_install.sh"
    else
      launchctl enable "${DOMAIN}/${MCP_LABEL}" >/dev/null 2>&1 || true
      launchctl enable "${DOMAIN}/${AUTO_LABEL}" >/dev/null 2>&1 || true
      bootout_if_exists "${MCP_PLIST}"
      bootout_if_exists "${AUTO_PLIST}"
      bootstrap_if_exists "${MCP_PLIST}"
      bootstrap_if_exists "${AUTO_PLIST}"
      launchctl kickstart -k "${DOMAIN}/${MCP_LABEL}" >/dev/null 2>&1 || true
      launchctl kickstart -k "${DOMAIN}/${AUTO_LABEL}" >/dev/null 2>&1 || true
      "${REPO_ROOT}/scripts/imprint_auto_snapshot_ctl.sh" start >/dev/null 2>&1 || true
    fi
    ;;
  off)
    "${REPO_ROOT}/scripts/imprint_auto_snapshot_ctl.sh" stop >/dev/null 2>&1 || true
    bootout_if_exists "${AUTO_PLIST}"
    bootout_if_exists "${MCP_PLIST}"
    ;;
  status)
    ;;
  install)
    "${REPO_ROOT}/scripts/launchd_install.sh"
    ;;
  uninstall)
    "${REPO_ROOT}/scripts/launchd_uninstall.sh"
    ;;
  *)
    echo "usage: $0 [on|off|status|install|uninstall]" >&2
    exit 2
    ;;
esac

MCP_RUNNING=false
AUTO_AGENT_LOADED=false
if is_loaded "${MCP_LABEL}"; then MCP_RUNNING=true; fi
if is_loaded "${AUTO_LABEL}"; then AUTO_AGENT_LOADED=true; fi

AUTO_SNAPSHOT_STATUS="{}"
if STATUS_JSON="$("${REPO_ROOT}/scripts/imprint_auto_snapshot_ctl.sh" status 2>/dev/null)"; then
  AUTO_SNAPSHOT_STATUS="${STATUS_JSON}"
fi

node --input-type=module - <<'NODE' \
"${ACTION}" \
"${DOMAIN}" \
"${MCP_LABEL}" \
"${AUTO_LABEL}" \
"${MCP_RUNNING}" \
"${AUTO_AGENT_LOADED}" \
"${MCP_PLIST}" \
"${AUTO_PLIST}" \
"${AUTO_SNAPSHOT_STATUS}"
const [
  action,
  domain,
  mcpLabel,
  autoLabel,
  mcpRunning,
  autoAgentLoaded,
  mcpPlist,
  autoPlist,
  autoSnapshotStatusRaw,
] = process.argv.slice(2);

let autoSnapshotStatus = {};
try {
  autoSnapshotStatus = JSON.parse(autoSnapshotStatusRaw);
} catch {
  autoSnapshotStatus = {};
}

const payload = {
  ok: true,
  action,
  domain,
  switches: {
    eyes: mcpRunning === 'true',
    ears: mcpRunning === 'true',
    fingers: mcpRunning === 'true',
  },
  launchd: {
    mcp_label: mcpLabel,
    mcp_loaded: mcpRunning === 'true',
    mcp_plist: mcpPlist,
    auto_snapshot_label: autoLabel,
    auto_snapshot_agent_loaded: autoAgentLoaded === 'true',
    auto_snapshot_plist: autoPlist,
  },
  auto_snapshot_runtime: autoSnapshotStatus,
};

process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
NODE
