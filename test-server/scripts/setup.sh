#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="$ROOT/runtime"
BUILD_ROOT="$ROOT/.buildtools"
PLUGIN_BUILD="$ROOT/.plugin-build"
SERVER_JAR="$RUNTIME/server.jar"
PLUGINS="$RUNTIME/plugins"

if [[ -n "${JAVA8_HOME:-}" ]]; then
  JAVA_BIN="$JAVA8_HOME/bin/java"
  JAVAC_BIN="$JAVA8_HOME/bin/javac"
  JAR_BIN="$JAVA8_HOME/bin/jar"
else
  JAVA_BIN="$(command -v java || true)"
  JAVAC_BIN="$(command -v javac || true)"
  JAR_BIN="$(command -v jar || true)"
fi

for tool in curl git; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required" >&2; exit 1; }
done
[[ -x "$JAVA_BIN" && -x "$JAVAC_BIN" && -x "$JAR_BIN" ]] || {
  echo "A JDK is required. For this 1.8.8 test server, JAVA8_HOME is recommended." >&2
  exit 1
}

mkdir -p "$RUNTIME" "$PLUGINS" "$BUILD_ROOT" "$PLUGIN_BUILD"

if [[ ! -f "$SERVER_JAR" ]]; then
  BUILDTOOLS="$BUILD_ROOT/BuildTools.jar"
  echo "[care-test] downloading official Spigot BuildTools"
  curl -fL "https://hub.spigotmc.org/jenkins/job/BuildTools/lastSuccessfulBuild/artifact/target/BuildTools.jar" -o "$BUILDTOOLS"

  echo "[care-test] building Spigot 1.8.8 (first setup can take several minutes)"
  pushd "$BUILD_ROOT" >/dev/null
  "$JAVA_BIN" -Xmx2G -jar "$BUILDTOOLS" --rev 1.8.8
  SPIGOT_JAR="$(find "$BUILD_ROOT" -maxdepth 1 -type f -name 'spigot-1.8.8*.jar' | head -n1)"
  [[ -n "$SPIGOT_JAR" ]] || { echo "BuildTools finished but no spigot-1.8.8 jar was found" >&2; exit 1; }
  cp -f "$SPIGOT_JAR" "$SERVER_JAR"
  popd >/dev/null
else
  echo "[care-test] reusing $SERVER_JAR"
fi

rm -rf "$PLUGIN_BUILD/classes"
mkdir -p "$PLUGIN_BUILD/classes"
mapfile -t SOURCES < <(find "$ROOT/plugin/src/main/java" -type f -name '*.java' -print)
[[ "${#SOURCES[@]}" -gt 0 ]] || { echo "No CareTest plugin sources found" >&2; exit 1; }

echo "[care-test] compiling BBotCareTest plugin"
"$JAVAC_BIN" -source 8 -target 8 -encoding UTF-8 -cp "$SERVER_JAR" -d "$PLUGIN_BUILD/classes" "${SOURCES[@]}"
cp "$ROOT/plugin/src/main/resources/plugin.yml" "$PLUGIN_BUILD/classes/plugin.yml"
"$JAR_BIN" cf "$PLUGINS/BBotCareTest.jar" -C "$PLUGIN_BUILD/classes" .

cat > "$RUNTIME/eula.txt" <<'EOF'
eula=true
EOF

cat > "$RUNTIME/server.properties" <<'EOF'
server-ip=127.0.0.1
server-port=25567
online-mode=false
motd=BBot Care Package Test Server
level-name=world
level-type=FLAT
generate-structures=false
spawn-protection=0
allow-flight=true
view-distance=8
max-players=20
difficulty=0
pvp=true
enable-command-block=false
spawn-animals=false
spawn-monsters=false
white-list=false
EOF

echo
echo "[care-test] ready"
echo "Server: 127.0.0.1:25567"
echo "Plugin: $PLUGINS/BBotCareTest.jar"
echo "Optional Vulcan: place your licensed Vulcan jar in $PLUGINS"
echo "Next: npm run test-server:use && npm run test-server:start"
