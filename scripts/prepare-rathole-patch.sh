#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="0.5.0"
TMP="$ROOT/.tmp-rathole-$VERSION"
DEST="$ROOT/vendor/rathole"
ARCHIVE="$TMP/rathole-$VERSION.crate"

rm -rf "$TMP" "$DEST"
mkdir -p "$TMP" "$ROOT/vendor"

curl -fsSL "https://crates.io/api/v1/crates/rathole/$VERSION/download" -o "$ARCHIVE"
tar -xzf "$ARCHIVE" -C "$TMP"
mv "$TMP/rathole-$VERSION" "$DEST"

git -C "$ROOT" apply --directory=vendor/rathole "$ROOT/patches/rathole-direct-api.patch"
grep -q "run_server_direct" "$DEST/src/lib.rs"
rm -rf "$TMP"
