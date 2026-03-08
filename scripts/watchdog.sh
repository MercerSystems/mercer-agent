#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Mercer Systems — watchdog.sh
# Auto-restarts the API server if it crashes.
# Usage: bash scripts/watchdog.sh
# ─────────────────────────────────────────────────────────────────────────────

cd "$(dirname "$0")/.." || exit 1

echo "[Watchdog] Starting Mercer server..."

while true; do
  node src/server.js
  EXIT_CODE=$?
  echo ""
  echo "[Watchdog] $(date '+%H:%M:%S') — Server exited (code $EXIT_CODE). Restarting in 3s..."
  sleep 3
done
