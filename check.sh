#!/bin/sh
# Self-check: the guards that keep this bridge a transcription service rather
# than a host file reader. Run against a live server: sh check.sh
set -eu

DIR=$(cd "$(dirname "$0")" && pwd)
PORT=${MACWHISPER_MCP_PORT:-10256}
URL="http://127.0.0.1:$PORT/mcp"
TOKEN=$(cat "$DIR/.token" 2>/dev/null || true)
fails=0

call() { # $1 = json body — always authorized
  curl -s -X POST "$URL" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d "$1"
}

expect() { # $1 = label, $2 = haystack, $3 = needle
  if printf '%s' "$2" | grep -q "$3"; then
    echo "ok   — $1"
  else
    echo "FAIL — $1: expected to find '$3' in: $2"
    fails=$((fails + 1))
  fi
}

expect "rejects a request with no token" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL" -H 'Content-Type: application/json' -d '{}')" \
  '401'

expect "path separators are refused" \
  "$(call '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"transcribe","arguments":{"file":"../../etc/hosts"}}}')" \
  'no path separators'

expect "a missing file is named, not swallowed" \
  "$(call '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"transcribe","arguments":{"file":"definitely-absent.mp3"}}}')" \
  'No such file'

# A symlink inside the directory still points outside it — the basename check
# alone would have passed this through to mw.
LINK_DIR=${MACWHISPER_MCP_DIR:-$HOME/nanoclaw-transcribe}
ln -sf /etc/hosts "$LINK_DIR/checkescape.mp3"
expect "a symlink out of the directory is refused" \
  "$(call '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"transcribe","arguments":{"file":"checkescape.mp3"}}}')" \
  'resolves outside'
rm -f "$LINK_DIR/checkescape.mp3"

[ "$fails" -eq 0 ] && echo "all checks passed" || { echo "$fails check(s) failed"; exit 1; }
