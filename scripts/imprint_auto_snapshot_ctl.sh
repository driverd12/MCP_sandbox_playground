#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-status}"
case "${ACTION}" in
  status|start|stop|run_once)
    ;;
  *)
    echo "usage: $0 [status|start|stop|run_once]" >&2
    exit 2
    ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

PROFILE_ID="${ANAMNESIS_IMPRINT_PROFILE_ID:-default}"
INTERVAL_SECONDS="${ANAMNESIS_IMPRINT_AUTO_SNAPSHOT_INTERVAL_SECONDS:-900}"
INCLUDE_RECENT_MEMORIES="${ANAMNESIS_IMPRINT_AUTO_SNAPSHOT_RECENT_MEMORIES:-20}"
INCLUDE_RECENT_TRANSCRIPT_LINES="${ANAMNESIS_IMPRINT_AUTO_SNAPSHOT_RECENT_TRANSCRIPT_LINES:-40}"
WRITE_FILE="${ANAMNESIS_IMPRINT_AUTO_SNAPSHOT_WRITE_FILE:-true}"
PROMOTE_SUMMARY="${ANAMNESIS_IMPRINT_AUTO_SNAPSHOT_PROMOTE_SUMMARY:-true}"
RUN_IMMEDIATELY="${ANAMNESIS_IMPRINT_AUTO_SNAPSHOT_RUN_IMMEDIATELY:-true}"

if [[ "${ACTION}" == "status" ]]; then
  ARGS_JSON='{"action":"status"}'
else
  NOW_TS="$(date +%s)"
  RAND_SUFFIX="$(node --input-type=module -e 'process.stdout.write(Math.random().toString(36).slice(2, 8));')"
  IDEMPOTENCY_KEY="imprint-auto-snapshot-${ACTION}-${NOW_TS}-${RAND_SUFFIX}"
  FINGERPRINT="imprint-auto-snapshot-fingerprint-${ACTION}-${NOW_TS}-${RAND_SUFFIX}"

  ARGS_JSON="$(node --input-type=module - <<'NODE' \
"${ACTION}" \
"${IDEMPOTENCY_KEY}" \
"${FINGERPRINT}" \
"${PROFILE_ID}" \
"${INTERVAL_SECONDS}" \
"${INCLUDE_RECENT_MEMORIES}" \
"${INCLUDE_RECENT_TRANSCRIPT_LINES}" \
"${WRITE_FILE}" \
"${PROMOTE_SUMMARY}" \
"${RUN_IMMEDIATELY}"
const [
  action,
  idempotencyKey,
  sideEffectFingerprint,
  profileId,
  intervalSeconds,
  includeRecentMemories,
  includeRecentTranscriptLines,
  writeFile,
  promoteSummary,
  runImmediately,
] = process.argv.slice(2);

function parseBoolean(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

const payload = {
  action,
  mutation: {
    idempotency_key: idempotencyKey,
    side_effect_fingerprint: sideEffectFingerprint,
  },
};

if (action !== 'stop') {
  payload.profile_id = profileId;
  payload.interval_seconds = Number.parseInt(intervalSeconds, 10);
  payload.include_recent_memories = Number.parseInt(includeRecentMemories, 10);
  payload.include_recent_transcript_lines = Number.parseInt(includeRecentTranscriptLines, 10);
  payload.write_file = parseBoolean(writeFile, true);
  payload.promote_summary = parseBoolean(promoteSummary, true);
}

if (action === 'start') {
  payload.run_immediately = parseBoolean(runImmediately, true);
}

process.stdout.write(JSON.stringify(payload));
NODE
)"
fi

node "${REPO_ROOT}/scripts/mcp_tool_call.mjs" \
  --tool imprint.auto_snapshot \
  --args "${ARGS_JSON}" \
  --cwd "${REPO_ROOT}"
