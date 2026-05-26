#!/usr/bin/env bash

set -euo pipefail

MODEL="${1:-${MODEL_NAME:-gemma4:26b}}"
OLLAMA_URL="${OLLAMA_BASE_URL:-http://localhost:11434}"
KEEP_ALIVE="${OLLAMA_KEEP_ALIVE:-10m}"

section() {
  printf '\n== %s ==\n' "$1"
}

warn() {
  printf 'WARN: %s\n' "$1" >&2
}

run_or_warn() {
  if ! "$@"; then
    warn "Command failed: $*"
  fi
}

section "Host GPU"
if command -v nvidia-smi >/dev/null 2>&1; then
  run_or_warn nvidia-smi
else
  warn "nvidia-smi is not installed or not on PATH."
fi

section "Docker GPU Runtime"
if command -v docker >/dev/null 2>&1; then
  run_or_warn docker run --rm --gpus all nvidia/cuda:12.0.0-runtime-ubuntu22.04 nvidia-smi
else
  warn "docker is not installed or not on PATH."
fi

section "Ollama Container"
if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'mcp-ollama'; then
  run_or_warn docker exec mcp-ollama nvidia-smi
  run_or_warn docker exec mcp-ollama ollama ps
  echo
  docker logs --tail 200 mcp-ollama 2>&1 | grep -Ei 'cuda|gpu|nvidia|driver|library|cpu' || true
else
  warn "mcp-ollama container is not running or Docker is not accessible."
fi

section "Backend Ollama Status"
run_or_warn curl -fsS http://localhost:3000/api/ollama/ps
echo

section "Preload Test"
echo "Loading model ${MODEL} through ${OLLAMA_URL} with keep_alive=${KEEP_ALIVE}..."
run_or_warn curl -fsS \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"${MODEL}\",\"stream\":false,\"keep_alive\":\"${KEEP_ALIVE}\"}" \
  "${OLLAMA_URL}/api/generate"
echo

section "Loaded Models After Preload"
if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'mcp-ollama'; then
  run_or_warn docker exec mcp-ollama ollama ps
else
  run_or_warn curl -fsS "${OLLAMA_URL}/api/ps"
  echo
fi

section "Host GPU After Preload"
if command -v nvidia-smi >/dev/null 2>&1; then
  run_or_warn nvidia-smi
else
  warn "nvidia-smi is not installed or not on PATH."
fi
