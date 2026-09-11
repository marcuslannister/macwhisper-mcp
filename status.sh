#!/bin/sh
# Operational status: is the bridge up, has it crashed recently, and is any
# `mw transcribe` invocation stuck or duplicated. Run any time: sh status.sh
set -eu

LABEL=com.macwhisper-mcp
LOG="$HOME/Library/Logs/macwhisper-mcp.log"
DIR=${MACWHISPER_MCP_DIR:-$HOME/nanoclaw-transcribe}

echo "== service =="
if launchctl list "$LABEL" >/dev/null 2>&1; then
  launchctl list "$LABEL" | sed -n '1,3p'
else
  echo "not loaded — run install.sh"
fi

echo
echo "== recent crashes (last 20 log lines matching a failure) =="
if [ -f "$LOG" ]; then
  MATCHES=$(grep -n "request failed\|TypeError\|Bun v" "$LOG" | tail -20 || true)
  [ -n "$MATCHES" ] && printf '%s\n' "$MATCHES" || echo "none found"
else
  echo "no log at $LOG"
fi

echo
echo "== mw transcribe processes =="
PROCS=$(ps -axo pid,etime,command | grep '[m]w transcribe' || true)
FILES=$(printf '%s\n' "$PROCS" | sed -n 's#.*mw transcribe \([^ ]*\) --format.*#\1#p' | xargs -n1 -I{} basename {} 2>/dev/null || true)
if [ -z "$PROCS" ]; then
  echo "none running"
else
  printf '%s\n' "$PROCS"
  echo
  DUPES=$(printf '%s\n' "$FILES" | sort | uniq -d)
  [ -n "$DUPES" ] && printf 'DUPLICATE — more than one process on: %s\n' "$DUPES"
fi

echo
echo "== shared transcribe directory: $DIR =="
if [ -d "$DIR" ]; then
  ls -la "$DIR" | tail -n +2
  for f in "$DIR"/*; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    if ! printf '%s\n' "$PROCS" | grep -q "$name"; then
      echo "IDLE — $name has no active mw transcribe process"
    fi
  done
else
  echo "does not exist"
fi
