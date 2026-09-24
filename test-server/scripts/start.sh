#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="$ROOT/runtime"

if [[ -f "$RUNTIME/plugins/Vulcan.jar" ]]; then
  if [[ -n "${TEST_SERVER_JAVA_HOME:-}" ]]; then
    JAVA_BIN="$TEST_SERVER_JAVA_HOME/bin/java"
  else
    JAVA_BIN="$(command -v java || true)"
  fi
  [[ -x "$JAVA_BIN" ]] || {
    echo "Vulcan is installed and requires Java 21+. Set TEST_SERVER_JAVA_HOME to a Java 21+ JDK." >&2
    exit 1
  }
  JAVA_MAJOR="$("$JAVA_BIN" -version 2>&1 | head -n1 | sed -E 's/.*version "([0-9]+).*/\1/')"
  if [[ ! "$JAVA_MAJOR" =~ ^[0-9]+$ ]] || (( JAVA_MAJOR < 21 )); then
    echo "Vulcan 2.9.7.22 requires Java 21+; test server is using: $("$JAVA_BIN" -version 2>&1 | head -n1)" >&2
    echo "Set TEST_SERVER_JAVA_HOME to a Java 21+ JDK. JAVA8_HOME remains reserved for Forge 1.8.9." >&2
    exit 1
  fi
else
  if [[ -n "${TEST_SERVER_JAVA_HOME:-}" ]]; then
    JAVA_BIN="$TEST_SERVER_JAVA_HOME/bin/java"
  elif [[ -n "${JAVA8_HOME:-}" ]]; then
    JAVA_BIN="$JAVA8_HOME/bin/java"
  else
    JAVA_BIN="$(command -v java || true)"
  fi
fi

[[ -x "$JAVA_BIN" ]] || { echo "Java not found." >&2; exit 1; }
[[ -f "$RUNTIME/server.jar" ]] || { echo "Run npm run test-server:setup first." >&2; exit 1; }

echo "[care-test] server Java: $("$JAVA_BIN" -version 2>&1 | head -n1)"
if [[ -f "$RUNTIME/plugins/Vulcan.jar" ]]; then
  echo "[care-test] Vulcan + PacketEvents enabled"
fi

cd "$RUNTIME"
exec "$JAVA_BIN" -Xms256M -Xmx1G -jar server.jar nogui
