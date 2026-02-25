#!/usr/bin/env bash
set -euo pipefail

APP_NAME="TriChat"
INSTALL_DIR="${HOME}/Applications"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRANSPORT="stdio"
TERMINAL_MODE="terminal"
ICON_PATH=""

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/install_trichat_app.sh [options]

Options:
  --icon <path>          Optional icon image file to apply to the app (.png recommended)
  --transport <mode>     stdio (default) or http
  --terminal <mode>      terminal (default) or alacritty
  --name <app-name>      App name (default: TriChat)
  --install-dir <path>   Install directory (default: ~/Applications)
  --repo-root <path>     Repository root (default: current repo)
  -h, --help             Show this help

Examples:
  ./scripts/install_trichat_app.sh --icon /absolute/path/to/3cats.png
  ./scripts/install_trichat_app.sh --transport http --terminal alacritty
USAGE
}

fail() {
  echo "error: $*" >&2
  exit 2
}

require_command() {
  local cmd="$1"
  command -v "${cmd}" >/dev/null 2>&1 || fail "missing required command: ${cmd}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --icon)
      [[ $# -ge 2 ]] || fail "--icon requires a path"
      ICON_PATH="$2"
      shift 2
      ;;
    --transport)
      [[ $# -ge 2 ]] || fail "--transport requires stdio|http"
      TRANSPORT="$2"
      shift 2
      ;;
    --terminal)
      [[ $# -ge 2 ]] || fail "--terminal requires terminal|alacritty"
      TERMINAL_MODE="$2"
      shift 2
      ;;
    --name)
      [[ $# -ge 2 ]] || fail "--name requires a value"
      APP_NAME="$2"
      shift 2
      ;;
    --install-dir)
      [[ $# -ge 2 ]] || fail "--install-dir requires a path"
      INSTALL_DIR="$2"
      shift 2
      ;;
    --repo-root)
      [[ $# -ge 2 ]] || fail "--repo-root requires a path"
      REPO_ROOT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

case "${TRANSPORT}" in
  stdio|http) ;;
  *) fail "--transport must be stdio or http (got: ${TRANSPORT})" ;;
esac

case "${TERMINAL_MODE}" in
  terminal|alacritty) ;;
  *) fail "--terminal must be terminal or alacritty (got: ${TERMINAL_MODE})" ;;
esac

REPO_ROOT="$(cd "${REPO_ROOT}" && pwd)"
INSTALL_DIR="$(mkdir -p "${INSTALL_DIR}" && cd "${INSTALL_DIR}" && pwd)"
APP_PATH="${INSTALL_DIR}/${APP_NAME}.app"

require_command osacompile
require_command osascript

if [[ "${TERMINAL_MODE}" == "alacritty" ]]; then
  require_command open
fi

if [[ -n "${ICON_PATH}" ]]; then
  ICON_PATH="$(cd "$(dirname "${ICON_PATH}")" && pwd)/$(basename "${ICON_PATH}")"
  [[ -f "${ICON_PATH}" ]] || fail "icon file does not exist: ${ICON_PATH}"
fi

LAUNCH_SCRIPT="npm run trichat:tui"
if [[ "${TRANSPORT}" == "http" ]]; then
  LAUNCH_SCRIPT="npm run trichat:tui:http"
fi

TMP_APPLESCRIPT="$(mktemp -t trichat-installer-XXXXXX.applescript)"
cleanup() {
  rm -f "${TMP_APPLESCRIPT}"
}
trap cleanup EXIT

if [[ "${TERMINAL_MODE}" == "terminal" ]]; then
  cat > "${TMP_APPLESCRIPT}" <<EOF
set repoPath to "${REPO_ROOT}"
set launchCmd to "cd " & quoted form of repoPath & " && ${LAUNCH_SCRIPT}"
tell application "Terminal"
  activate
  do script launchCmd
end tell
EOF
else
  cat > "${TMP_APPLESCRIPT}" <<EOF
set repoPath to "${REPO_ROOT}"
set launchCmd to "cd " & quoted form of repoPath & " && ${LAUNCH_SCRIPT}"
do shell script "open -a Alacritty --args -e zsh -lc " & quoted form of launchCmd
EOF
fi

if [[ -e "${APP_PATH}" ]]; then
  TS="$(date +%Y%m%d-%H%M%S)"
  BACKUP_PATH="${APP_PATH}.backup-${TS}"
  mv "${APP_PATH}" "${BACKUP_PATH}"
  echo "existing app moved to ${BACKUP_PATH}" >&2
fi

osacompile -o "${APP_PATH}" "${TMP_APPLESCRIPT}" >/dev/null

if [[ -n "${ICON_PATH}" ]]; then
  ICON_POSIX="${ICON_PATH}" APP_POSIX="${APP_PATH}" osascript <<'OSA' >/dev/null
set iconPosix to system attribute "ICON_POSIX"
set appPosix to system attribute "APP_POSIX"
tell application "Finder"
  set sourceFile to POSIX file iconPosix as alias
  set targetFile to POSIX file appPosix as alias
  set icon of targetFile to icon of sourceFile
end tell
OSA
fi

echo "installed ${APP_PATH}" >&2
echo "launch target: ${LAUNCH_SCRIPT}" >&2
if [[ -n "${ICON_PATH}" ]]; then
  echo "icon applied from: ${ICON_PATH}" >&2
fi
