#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="$ROOT/runtime"

if [[ -n "${JAVA8_HOME:-}" ]]; then
  JAVA_BIN="$JAVA8_HOME/bin/java"
else
  JAVA_BIN="$(command -v java || true)"
fi

[[ -x "$JAVA_BIN" ]] || { echo "Java not found. Set JAVA8_HOME." >&2; exit 1; }
[[ -f "$RUNTIME/server.jar" ]] || { echo "Run npm run test-server:setup first." >&2; exit 1; }

cd "$RUNTIME"
exec "$JAVA_BIN" -Xms256M -Xmx1G -jar server.jar nogui
