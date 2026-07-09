$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$version = "0.5.0"
$tmp = Join-Path $root ".tmp-rathole-$version"
$dest = Join-Path $root "vendor\rathole"
$fetch = Join-Path $tmp "fetch"

Remove-Item -Recurse -Force $tmp, $dest -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $fetch, (Join-Path $root "vendor") | Out-Null

$manifest = @"
[package]
name = "rathole-source-fetch"
version = "0.0.0"
edition = "2021"

[dependencies]
rathole = "=$version"
"@
Set-Content -LiteralPath (Join-Path $fetch "Cargo.toml") -Value $manifest -NoNewline

# cargo refuses to parse a package with no target, so give it an empty lib.
New-Item -ItemType Directory -Force (Join-Path $fetch "src") | Out-Null
Set-Content -LiteralPath (Join-Path $fetch "src\lib.rs") -Value "" -NoNewline

Push-Location $fetch
try {
    cargo vendor --versioned-dirs (Join-Path $tmp "vendor") | Out-Null
} finally {
    Pop-Location
}
Move-Item -LiteralPath (Join-Path $tmp "vendor\rathole-$version") -Destination $dest

$patch = Join-Path $root "patches\rathole-direct-api.patch"
git -C $root apply --ignore-whitespace --directory=vendor/rathole $patch
if ($LASTEXITCODE -ne 0) {
    throw "failed to apply rathole patch"
}
if (-not (Select-String -Path (Join-Path $dest "src\lib.rs") -Pattern "run_server_direct" -Quiet)) {
    throw "rathole patch did not apply"
}
Remove-Item -Recurse -Force $tmp
