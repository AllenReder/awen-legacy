$ErrorActionPreference = "Stop"
# The NSIS installer is what users install, and installing it is the
# step that drops symlinks and junctions from the bundled runtime.
# Start the daemon it carries and read /api/auth/session here, before
# the artifact is uploaded.
$installer = Get-ChildItem "apps/desktop/dist-package" -Filter "*.exe" |
  Select-Object -First 1
if (-not $installer) { throw "No NSIS installer was produced." }
Write-Host "Installing $($installer.FullName)"
$installDir = Join-Path $env:RUNNER_TEMP "awen-installed-smoke"
$unpacked = Join-Path $pwd "apps/desktop/dist-package/win-unpacked"
if (-not (Test-Path "$unpacked/resources/runtime/dist/bin.mjs")) { throw "Unpacked runtime entry is missing." }
& "$unpacked/resources/runtime/node.exe" "$unpacked/resources/runtime/dist/bin.mjs" --version
if ($LASTEXITCODE -ne 0) { throw "Unpacked daemon failed." }
$install = Start-Process -FilePath $installer.FullName -ArgumentList @("/S", "/D=$installDir") -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "The installer exited with $($install.ExitCode)." }
$runtime = Join-Path $installDir "resources\runtime"
$node = Join-Path $runtime "node.exe"
$entry = Join-Path $runtime "dist\bin.mjs"
for ($attempt = 0; $attempt -lt 30 -and -not (Test-Path $entry); $attempt++) { Start-Sleep -Seconds 1 }
if (-not (Test-Path $entry)) { throw "The installer did not lay down $runtime." }
# A silent install may still launch the app; this check only needs the
# runtime, and the app must not hold the daemon host port.
Get-Process Awen -ErrorAction SilentlyContinue | Stop-Process -Force
$baseDir = Join-Path $env:RUNNER_TEMP "awen-desktop-smoke-home"
$env:AWEN_NO_BROWSER = "1"
try {
  $output = & $node $entry daemon start --json --base-dir $baseDir 2>&1
  $exitCode = $LASTEXITCODE
  $text = $output | Out-String
  if ($exitCode -ne 0) { throw "The packaged daemon failed to start ($exitCode): $text" }
  $started = $text -split "\r?\n" | Where-Object { $_.TrimStart().StartsWith("{") } | Select-Object -Last 1
  if (-not $started) { throw "The packaged daemon printed no JSON: $text" }
  $origin = ($started | ConvertFrom-Json).origin
  if (-not $origin) { throw "The packaged daemon reported no origin: $started" }
  $session = Invoke-RestMethod "$($origin)api/auth/session" -TimeoutSec 30
  if ($session.auth.policy -ne "desktop-managed-local") {
    throw "Unexpected /api/auth/session payload: $($session | ConvertTo-Json -Compress)"
  }
  Write-Host "The packaged daemon answered /api/auth/session from $origin."
  $env:AWEN_SMOKE_RUNTIME = $runtime
  $application = Join-Path $installDir "Awen.exe"
  node apps/desktop/scripts/smoke-test.mjs --executable $application
  if ($LASTEXITCODE -ne 0) { throw "Installed Electron smoke test failed." }
} finally {
  & $node $entry daemon stop --json --confirm --base-dir $baseDir 2>$null | Out-Null
  Get-Process Awen -ErrorAction SilentlyContinue | Stop-Process -Force
  $uninstaller = Join-Path $installDir "Uninstall Awen.exe"
  if (Test-Path $uninstaller) {
    Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait | Out-Null
  }
  $log = Join-Path $baseDir "userdata\logs\daemon.log"
  if (Test-Path $log) {
    Write-Host "--- daemon.log (tail) ---"
    Get-Content $log -Tail 50
  }
}
