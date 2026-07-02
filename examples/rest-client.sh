#!/usr/bin/env bash
# ─── REST API Example ─────────────────────────────────────────────────────────
# Shows the full lifecycle: create bot → run skill → cancel → destroy.
#
# Prerequisites: mc-agent-service running at $HOST:$PORT
#   npm run dev
#
# Usage:
#   chmod +x examples/rest-client.sh
#   ./examples/rest-client.sh
#   HOST=192.168.1.5 ./examples/rest-client.sh   # remote service
#
set -euo pipefail

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-3001}"
BASE="http://$HOST:$PORT"

echo "=== 1. Health check ==="
curl -s "$BASE/health" | head -c 200
echo

echo "=== 2. Create bot ==="
BOT_JSON=$(curl -s -X POST "$BASE/bots" \
  -H "Content-Type: application/json" \
  -d '{
    "bot": {
      "name": "DemoBot",
      "minecraft": {
        "host": "127.0.0.1",
        "port": 25565,
        "username": "DemoBot",
        "auth": "offline",
        "version": "auto"
      }
    },
    "connect": false
  }')
echo "$BOT_JSON" | head -c 400
BOT_ID=$(echo "$BOT_JSON" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
echo
echo "Bot ID: $BOT_ID"

echo "=== 3. List skills ==="
curl -s "$BASE/skills" | head -c 400
echo

echo "=== 4. List bots ==="
curl -s "$BASE/bots" | head -c 400
echo

echo "=== 5. Get bot detail ==="
curl -s "$BASE/bots/$BOT_ID" | head -c 400
echo

echo "=== 6. Destroy bot ==="
curl -s -X DELETE "$BASE/bots/$BOT_ID"
echo

echo "=== Done ==="
echo
echo "With a connected bot, you could also:"
echo "  curl -X POST $BASE/bots/$BOT_ID/actions/move.to_position \\"
echo '    -H "Content-Type: application/json" -d '"'"'{"params":{"x":0,"y":64,"z":0}}'"'"
echo "  curl $BASE/bots/$BOT_ID/state"
echo "  curl -X POST $BASE/bots/$BOT_ID/chat \\"
echo '    -H "Content-Type: application/json" -d '"'"'{"message":"hello"}'"'"
