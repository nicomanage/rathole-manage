$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$version = "0.5.0"
$tmp = Join-Path $root ".tmp-rathole-$version"
$dest = Join-Path $root "vendor\rathole"
$archive = Join-Path $tmp "rathole-$version.crate"

Remove-Item -Recurse -Force $tmp, $dest -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $tmp, (Join-Path $root "vendor") | Out-Null

Invoke-WebRequest -Uri "https://crates.io/api/v1/crates/rathole/$version/download" -OutFile $archive
tar -xzf $archive -C $tmp
Move-Item -LiteralPath (Join-Path $tmp "rathole-$version") -Destination $dest

$patch = Join-Path $root "patches\rathole-direct-api.patch"
git -C $root apply --directory=vendor/rathole $patch
if ($LASTEXITCODE -ne 0) {
    throw "failed to apply rathole patch"
}
if (-not (Select-String -Path (Join-Path $dest "src\lib.rs") -Pattern "run_server_direct" -Quiet)) {
    throw "rathole patch did not apply"
}
Remove-Item -Recurse -Force $tmp
