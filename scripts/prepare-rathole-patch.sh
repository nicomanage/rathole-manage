#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="0.5.0"
TMP="$ROOT/.tmp-rathole-$VERSION"
DEST="$ROOT/vendor/rathole"

rm -rf "$TMP" "$DEST"
mkdir -p "$TMP" "$ROOT/vendor"

cargo vendor --versioned-dirs --sync "$ROOT/agent/Cargo.toml" "$TMP/vendor" >/dev/null
mv "$TMP/vendor/rathole-$VERSION" "$DEST"

git -C "$ROOT" apply --directory=vendor/rathole "$ROOT/patches/rathole-direct-api.patch"
grep -q "run_server_direct" "$DEST/src/lib.rs"
rm -rf "$TMP"
