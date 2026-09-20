#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="$ROOT/runtime"
GAME_DIR="$RUNTIME/game"
HMC_DIR="$RUNTIME/HeadlessMC"

HMC_VERSION="2.10.0"
HMC_JAR="$RUNTIME/headlessmc-launcher-$HMC_VERSION.jar"
HMC_URL="https://github.com/headlesshq/headlessmc/releases/download/$HMC_VERSION/headlessmc-launcher-$HMC_VERSION.jar"

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

JAVA_VERSION="$("$JAVA_BIN" -version 2>&1 | head -n1)"
if [[ "$JAVA_VERSION" != *'"1.8.'* ]]; then
  echo "Headless Forge 1.8.9 should use Java 8; got: $JAVA_VERSION" >&2
  echo "Set JAVA8_HOME to a Java 8 installation." >&2
  exit 1
fi

if [[ ! -f "$POC_JAR" ]]; then
  echo "Missing $POC_JAR" >&2
  echo "Run ./scripts/build.sh first." >&2
  exit 1
fi

command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }

mkdir -p "$GAME_DIR/mods" "$HMC_DIR"

if [[ ! -f "$HMC_JAR" ]]; then
  echo "[BBotPoC] downloading HeadlessMC $HMC_VERSION"
  curl -fL "$HMC_URL" -o "$HMC_JAR"
fi

# HeadlessMC's -specifics launch flag installs the version-matched HMC-Specifics
# mod. Remove the old manually-copied jar so Forge does not see a stale/duplicate copy.
rm -f "$GAME_DIR/mods/hmc-specifics-1.8.9-forge-latest.jar"
cp -f "$POC_JAR" "$GAME_DIR/mods/"

cat > "$HMC_DIR/config.properties" <<EOF
hmc.gamedir=$GAME_DIR
hmc.assets.dummy=true
hmc.rethrow.launch.exceptions=true
hmc.java.versions=$JAVA_BIN
# Supervisor launches HeadlessMC with piped stdin/stdout. Disable JLine so
# launch/quit commands sent through the pipe are consumed reliably.
hmc.jline.enabled=false
EOF

echo "[BBotPoC] runtime prepared in $RUNTIME"
echo "[BBotPoC] next: ./scripts/run-hmc.sh"
echo "[BBotPoC] launch with: launch forge:1.8.9 -specifics -lwjgl --jvm \"-Djava.awt.headless=true -Xms256m -Xmx768m\""
