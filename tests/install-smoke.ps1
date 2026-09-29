<#
  Installer smoke test: installs build/release (from `npm run package`) into a temporary folder
  on a spare port, checks that it runs on its own Node.js and answers with the right version,
  then uninstalls it and checks nothing is left. Leaves any real ipman install alone.

  Run with Windows PowerShell 5.1, like users' machines:
    powershell -NoProfile -ExecutionPolicy Bypass -File tests\install-smoke.ps1
#>
param([int]$Port = 5199)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$release = Join-Path $root 'build\release'
$installDir = Join-Path $env:TEMP ('ipman-smoke-' + [guid]::NewGuid().ToString('N'))
$expected = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$failed = 0
function Check([string]$What, [bool]$Ok, [string]$Detail = '') {
  if ($Ok) { Write-Host "  PASS  $What" } else { Write-Host "  FAIL  $What $Detail" -ForegroundColor Red; $script:failed++ }
}

if (-not (Test-Path (Join-Path $release 'ipman.zip'))) { throw 'build\release\ipman.zip is missing: run npm run package first.' }
# The start-menu shortcut and Installed-apps entry are per user; don't clobber a real install's.
if (Test-Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ipman') {
  throw 'ipman is installed for this user; the smoke test would replace its shortcuts. Run it on a machine or account without ipman (e.g. CI).'
}

Write-Host "Installing into $installDir on port $Port"
& ([scriptblock]::Create((Get-Content -Raw (Join-Path $release 'install.ps1')))) -Source $release -Path $installDir -Port $Port -NoAutostart -NoBrowser

try {
  $version = (Invoke-RestMethod "http://127.0.0.1:$Port/version" -TimeoutSec 5).version
} catch { $version = $null }
Check 'server answers with the packaged version' ($version -eq $expected) "(got '$version', expected '$expected')"

$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$exe = if ($conn) { (Get-CimInstance Win32_Process -Filter "ProcessId = $($conn.OwningProcess)").ExecutablePath } else { '' }
# Normalize both sides: Windows may report the path in long form while $env:TEMP is in short 8.3
# form (C:\Users\RUNNER~1 on GitHub's machines). GetFullPath expands short names of existing folders.
$ownNode = [IO.Path]::GetFullPath((Join-Path $installDir 'node\node.exe'))
Check "server runs on the installer's own node.exe" ($exe -and [IO.Path]::GetFullPath($exe) -eq $ownNode) "(runs from '$exe')"
$page = try { (Invoke-WebRequest "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 5).StatusCode } catch { 0 }
Check 'frontend is served' ($page -eq 200)
Check 'ffmpeg installed next to it' (Test-Path (Join-Path $installDir 'ffmpeg\ffmpeg.exe'))
Check 'no autostart with -NoAutostart' (-not (Test-Path (Join-Path ([Environment]::GetFolderPath('Startup')) 'ipman.lnk')))

Write-Host 'Uninstalling'
& ([scriptblock]::Create((Get-Content -Raw (Join-Path $release 'install.ps1')))) -Uninstall -Path $installDir
Start-Sleep -Seconds 1
Check 'install folder removed' (-not (Test-Path $installDir))
Check 'server stopped' (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue))
Check 'Installed apps entry removed' (-not (Test-Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ipman'))
Check 'start menu shortcut removed' (-not (Test-Path (Join-Path ([Environment]::GetFolderPath('Programs')) 'ipman.lnk')))

if ($failed) { throw "$failed installer check(s) failed" }
Write-Host 'Installer smoke test passed' -ForegroundColor Green
