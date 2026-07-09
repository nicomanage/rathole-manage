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

# cargo refuses to parse a package with no target, so give it an empty lib.
mkdir -p "$FETCH/src"
: > "$FETCH/src/lib.rs"

(cd "$FETCH" && cargo vendor --versioned-dirs "$TMP/vendor" >/dev/null)
mv "$TMP/vendor/rathole-$VERSION" "$DEST"

git -C "$ROOT" apply --ignore-whitespace --directory=vendor/rathole "$ROOT/patches/rathole-direct-api.patch"
grep -q "run_server_direct" "$DEST/src/lib.rs"
rm -rf "$TMP"
