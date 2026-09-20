#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="$ROOT/runtime"
HMC_JAR="$RUNTIME/headlessmc-launcher-2.10.0.jar"

if [[ -n "${JAVA8_HOME:-}" ]]; then
  JAVA_BIN="$JAVA8_HOME/bin/java"
else
  JAVA_BIN="$(command -v java || true)"
fi

if [[ -z "$JAVA_BIN" || ! -x "$JAVA_BIN" ]]; then
  echo "Java 8 is required. Set JAVA8_HOME." >&2
  exit 1
fi

if [[ ! -f "$HMC_JAR" ]]; then
  echo "HeadlessMC is not bootstrapped." >&2
  echo "Run ./scripts/bootstrap-headless.sh first." >&2
  exit 1
fi

export BBOT_POC_WARMUP_TICKS="${BBOT_POC_WARMUP_TICKS:-300}"
export BBOT_POC_WALK_TICKS="${BBOT_POC_WALK_TICKS:-200}"
export BBOT_POC_SPRINT_TICKS="${BBOT_POC_SPRINT_TICKS:-200}"
export BBOT_POC_TRACE_EVERY_TICKS="${BBOT_POC_TRACE_EVERY_TICKS:-20}"

cd "$RUNTIME"
exec "$JAVA_BIN" -jar "$HMC_JAR"
