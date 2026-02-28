#!/usr/bin/env bash
# Stop the RFID Spectrum Analyzer processes
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="$SCRIPT_DIR/.pids"

if [ ! -f "$PIDFILE" ]; then
    echo "No running processes found (.pids file missing)"
    exit 0
fi

while IFS='=' read -r name pid; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        echo "Stopping $name (PID $pid)..."
        kill "$pid" 2>/dev/null || true
    else
        echo "  $name (PID $pid) already stopped"
    fi
done < "$PIDFILE"

rm -f "$PIDFILE"
echo "All stopped."
