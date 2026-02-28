#!/usr/bin/env bash
# Start the RFID Spectrum Analyzer (backend + frontend dev server)
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="$SCRIPT_DIR/.pids"

# Clean stale pidfile
rm -f "$PIDFILE"

cleanup() {
    echo ""
    echo "Shutting down..."
    "$SCRIPT_DIR/stop.sh" 2>/dev/null
}
trap cleanup EXIT

# --- Backend (Python WebSocket server) ---
echo "Starting backend server..."
DYLD_LIBRARY_PATH=/opt/homebrew/lib python3 "$SCRIPT_DIR/server.py" "$@" &
BACKEND_PID=$!
echo "backend=$BACKEND_PID" >> "$PIDFILE"
echo "  Backend PID $BACKEND_PID (ws://localhost:8765)"

# --- Frontend (Vite dev server) ---
echo "Starting frontend dev server..."
cd "$SCRIPT_DIR"
npx vite --host &
FRONTEND_PID=$!
echo "frontend=$FRONTEND_PID" >> "$PIDFILE"
echo "  Frontend PID $FRONTEND_PID (http://localhost:8080)"

echo ""
echo "Ready — open http://localhost:8080"
echo "Press Ctrl+C to stop both."

wait
