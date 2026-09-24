#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="$ROOT/runtime"
PLUGINS="$RUNTIME/plugins"
EXPECTED_VULCAN_SHA256="8139b190573ea016bd07e9e39e48ce35071c3ab6a6bb41cd9e820daa07623e37"
PACKETEVENTS_URL="https://github.com/retrooper/packetevents/releases/download/v2.14.0/packetevents-spigot-2.14.0.jar"
PACKETEVENTS_SHA256="060087c58ec268eae7dd0eb1f17ac3bea1eaadda1693414141ff64e506091bd7"

SOURCE="${1:-}"
if [[ -z "$SOURCE" ]]; then
  echo "Usage: npm run test-server:install-vulcan -- /path/to/Vulcan.jar" >&2
  exit 2
fi
[[ -f "$SOURCE" ]] || { echo "Vulcan jar not found: $SOURCE" >&2; exit 1; }

for tool in sha256sum unzip curl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required" >&2; exit 1; }
done

ACTUAL_SHA256="$(sha256sum "$SOURCE" | awk '{print $1}')"
if [[ "$ACTUAL_SHA256" != "$EXPECTED_VULCAN_SHA256" ]]; then
  echo "Refusing unexpected Vulcan jar." >&2
  echo "Expected SHA-256: $EXPECTED_VULCAN_SHA256" >&2
  echo "Actual SHA-256:   $ACTUAL_SHA256" >&2
  exit 1
fi

PLUGIN_YML="$(unzip -p "$SOURCE" plugin.yml 2>/dev/null || true)"
grep -Eq '^name:[[:space:]]*Vulcan[[:space:]]*$' <<<"$PLUGIN_YML" || {
  echo "plugin.yml does not identify this jar as Vulcan." >&2
  exit 1
}
grep -Eq '^version:[[:space:]]*2\.9\.7\.22[[:space:]]*$' <<<"$PLUGIN_YML" || {
  echo "Expected Vulcan 2.9.7.22." >&2
  exit 1
}
grep -Eq '^depend:[[:space:]]*\[packetevents\][[:space:]]*$' <<<"$PLUGIN_YML" || {
  echo "Expected Vulcan dependency on PacketEvents was not found." >&2
  exit 1
}

mkdir -p "$PLUGINS"
cp -f "$SOURCE" "$PLUGINS/Vulcan.jar"
echo "[care-test] installed Vulcan 2.9.7.22"

PE="$PLUGINS/packetevents-spigot-2.14.0.jar"
if [[ ! -f "$PE" ]] || [[ "$(sha256sum "$PE" | awk '{print $1}')" != "$PACKETEVENTS_SHA256" ]]; then
  echo "[care-test] downloading PacketEvents 2.14.0"
  curl -fL "$PACKETEVENTS_URL" -o "$PE.tmp"
  ACTUAL_PE_SHA="$(sha256sum "$PE.tmp" | awk '{print $1}')"
  if [[ "$ACTUAL_PE_SHA" != "$PACKETEVENTS_SHA256" ]]; then
    rm -f "$PE.tmp"
    echo "PacketEvents SHA-256 verification failed." >&2
    echo "Expected: $PACKETEVENTS_SHA256" >&2
    echo "Actual:   $ACTUAL_PE_SHA" >&2
    exit 1
  fi
  mv -f "$PE.tmp" "$PE"
fi

cat > "$RUNTIME/vulcan-install.txt" <<EOF
Vulcan version: 2.9.7.22
Vulcan SHA-256: $EXPECTED_VULCAN_SHA256
PacketEvents version: 2.14.0
PacketEvents SHA-256: $PACKETEVENTS_SHA256
Java requirement: 21+ for this Vulcan jar
EOF

echo "[care-test] PacketEvents 2.14.0 ready"
echo "[care-test] IMPORTANT: this Vulcan jar contains Java 21 classes."
echo "[care-test] test-server:start will require Java 21+; Forge 1.8.9 still uses Java 8 separately."
