#!/bin/sh
# Install (or reinstall) macwhisper-mcp as a launchd user agent.
#
# The plist is generated here rather than committed, because launchd needs
# absolute paths and does not expand $HOME. Everything is derived from this
# script's own location, so the repo stays machine-neutral.
set -eu

DIR=$(cd "$(dirname "$0")" && pwd)
LABEL=com.macwhisper-mcp
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs"
BUN=$(command -v bun || true)

if [ -z "$BUN" ]; then
  echo "bun not found on PATH — install bun, or edit this script to use node." >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

# Shared token. Loopback reaches every local process, so the port needs a gate
# of its own. Generated once and kept 0600; the same value goes into the
# calling agent group's MCP headers.
if [ ! -f "$DIR/.token" ]; then
  umask 077
  openssl rand -hex 32 > "$DIR/.token"
  echo "generated $DIR/.token — wire it as the Authorization header:"
  echo "  ncl groups config add-mcp-server --id <group-id> --name macwhisper \\"
  echo "    --url http://host.docker.internal:10256/mcp \\"
  echo "    --headers \"{\\\"Authorization\\\":\\\"Bearer \$(cat '$DIR/.token')\\\"}\""
fi
chmod 600 "$DIR/.token"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BUN</string>
    <string>run</string>
    <string>$DIR/server.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/macwhisper-mcp.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/macwhisper-mcp.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL — log: $LOG_DIR/macwhisper-mcp.log"
