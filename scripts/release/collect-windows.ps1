$ErrorActionPreference = "Stop"
$assets = "release-assets"
New-Item -ItemType Directory -Force $assets | Out-Null
$bundleRoot = "apps/desktop/dist-package"
$files = @(Get-ChildItem $bundleRoot -File -Filter "Awen-$env:VERSION-windows-x64.exe")
if ($files.Count -ne 1) { throw "Expected one root NSIS installer, found $($files.Count)." }
Copy-Item $files[0].FullName $assets
