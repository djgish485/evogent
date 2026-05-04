#!/bin/bash
set -euo pipefail

CURATION_LOG_FILE="${1:-}"
CURATION_TIMESTAMP="${2:-$(date -u +%Y-%m-%dT%H-%M-%S-%3NZ)}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DATA_DIR="${DATA_DIR:-${APP_DIR}/data}"
LOG_DIR="${DATA_DIR}/agent-logs"
CHAT_FILE="${DATA_DIR}/chat-output.jsonl"
INTAKE_TIMESTAMP="$(date -u +%Y-%m-%dT%H-%M-%S-%3NZ)"
INTAKE_LOG="${LOG_DIR}/intake-${INTAKE_TIMESTAMP}.log"

mkdir -p "${LOG_DIR}"

(
  cd "${APP_DIR}"
  npx tsx scripts/intake-enrich.ts >> "${INTAKE_LOG}" 2>&1
) &
INTAKE_PID=$!
echo "{\"id\":\"chat-intake-started-${INTAKE_TIMESTAMP}\",\"role\":\"assistant\",\"type\":\"agent_event\",\"text\":\"Intake enrichment sub-agent started.\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"metadata\":{\"event\":\"intake_started\",\"status\":\"running\",\"pid\":${INTAKE_PID},\"logFile\":\"${INTAKE_LOG}\",\"hasTranscript\":true,\"curationLogFile\":\"${CURATION_LOG_FILE}\",\"curationTimestamp\":\"${CURATION_TIMESTAMP}\"}}" >> "${CHAT_FILE}"

echo "Post-curation intake enrichment started (PID ${INTAKE_PID}, log ${INTAKE_LOG})."
