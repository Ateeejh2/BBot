#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="$ROOT/.cache"
GRADLE_VERSION="4.5"
GRADLE_HOME="$CACHE/gradle-$GRADLE_VERSION"

if [[ -n "${JAVA8_HOME:-}" ]]; then
  export JAVA_HOME="$JAVA8_HOME"
  export PATH="$JAVA_HOME/bin:$PATH"
fi

if ! command -v java >/dev/null 2>&1; then
  echo "Java 8 is required. Set JAVA8_HOME or install a Java 8 JDK." >&2
  exit 1
fi

JAVA_VERSION="$(java -version 2>&1 | head -n1)"
if [[ "$JAVA_VERSION" != *'"1.8.'* ]]; then
  echo "Forge 1.8.9 build requires Java 8; got: $JAVA_VERSION" >&2
  echo "Set JAVA8_HOME to a Java 8 JDK and run this script again." >&2
  exit 1
fi

command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
command -v unzip >/dev/null 2>&1 || { echo "unzip is required" >&2; exit 1; }

mkdir -p "$CACHE"

if [[ ! -x "$GRADLE_HOME/bin/gradle" ]]; then
  ZIP="$CACHE/gradle-$GRADLE_VERSION-bin.zip"
  echo "[BBotPoC] downloading Gradle $GRADLE_VERSION"
  curl -fL "https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip" -o "$ZIP"
  rm -rf "$GRADLE_HOME"
  unzip -q "$ZIP" -d "$CACHE"
fi

GRADLE="$GRADLE_HOME/bin/gradle"
cd "$ROOT"

if [[ ! -f ".poc-workspace-ready" ]]; then
  echo "[BBotPoC] preparing Forge 1.8.9 workspace (first run only)"
  "$GRADLE" --no-daemon setupDecompWorkspace
  touch ".poc-workspace-ready"
fi

echo "[BBotPoC] building"
"$GRADLE" --no-daemon clean build

echo "[BBotPoC] built: $ROOT/build/libs/bbot-headless-poc-0.1.0.jar"
