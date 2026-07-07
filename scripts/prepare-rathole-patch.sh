#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="0.5.0"
TMP="$ROOT/.tmp-rathole-$VERSION"
DEST="$ROOT/vendor/rathole"
FETCH="$TMP/fetch"

rm -rf "$TMP" "$DEST"
mkdir -p "$FETCH" "$ROOT/vendor"

cat > "$FETCH/Cargo.toml" <<EOF
[package]
name = "rathole-source-fetch"
version = "0.0.0"
edition = "2021"

[dependencies]
rathole = "=$VERSION"
EOF

(cd "$FETCH" && cargo vendor --versioned-dirs "$TMP/vendor" >/dev/null)
mv "$TMP/vendor/rathole-$VERSION" "$DEST"

git -C "$ROOT" apply --directory=vendor/rathole "$ROOT/patches/rathole-direct-api.patch"
grep -q "run_server_direct" "$DEST/src/lib.rs"
rm -rf "$TMP"
