#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_RUNTIME="$ROOT/runtime"
RUNTIME="${BBOT_HMC_RUNTIME:-$BASE_RUNTIME}"
GAME_DIR="$RUNTIME/game"
HMC_DIR="$RUNTIME/HeadlessMC"
HMC_JAR="$BASE_RUNTIME/headlessmc-launcher-2.10.0.jar"
HMC_SPECIFICS_JAR="$BASE_RUNTIME/hmc-specifics-1.8.9-2.4.0-lexforge-release.jar"
POC_JAR="$ROOT/build/libs/bbot-headless-poc-0.1.0.jar"

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

if [[ ! -f "$POC_JAR" ]]; then
  echo "Forge bridge mod is not built." >&2
  echo "Run ./scripts/build.sh first." >&2
  exit 1
fi

if [[ ! -f "$HMC_SPECIFICS_JAR" ]]; then
  echo "Pinned HMC-Specifics is not bootstrapped." >&2
  echo "Run ./scripts/bootstrap-headless.sh first." >&2
  exit 1
fi

export BBOT_POC_WARMUP_TICKS="${BBOT_POC_WARMUP_TICKS:-300}"
export BBOT_POC_WALK_TICKS="${BBOT_POC_WALK_TICKS:-200}"
export BBOT_POC_SPRINT_TICKS="${BBOT_POC_SPRINT_TICKS:-200}"
export BBOT_POC_TRACE_EVERY_TICKS="${BBOT_POC_TRACE_EVERY_TICKS:-20}"

if [[ "$RUNTIME" != "$BASE_RUNTIME" ]]; then
  mkdir -p "$GAME_DIR/mods" "$HMC_DIR"

  # Large immutable Minecraft assets are shared. Each worker keeps its own
  # game root, mods, HeadlessMC config and logs so 10 workers can coexist.
  for name in assets libraries versions; do
    source="$BASE_RUNTIME/game/$name"
    target="$GAME_DIR/$name"
    if [[ -e "$source" && ! -e "$target" && ! -L "$target" ]]; then
      ln -s "$source" "$target"
    fi
  done

  rm -f "$GAME_DIR/mods"/hmc-specifics-*.jar
  cp -f "$HMC_SPECIFICS_JAR" "$GAME_DIR/mods/"
  cp -f "$POC_JAR" "$GAME_DIR/mods/"

  cat > "$HMC_DIR/config.properties" <<EOF
hmc.gamedir=$GAME_DIR
hmc.assets.dummy=true
hmc.rethrow.launch.exceptions=true
hmc.java.versions=$JAVA_BIN
hmc.jline.enabled=false
EOF
fi

cd "$RUNTIME"
exec "$JAVA_BIN" -jar "$HMC_JAR"
