<#
  ipman installer: installs or updates ipman for the current user. No admin rights needed.

  Install or update (run in PowerShell):
    irm https://github.com/EndreJordal/ipman/releases/latest/download/install.ps1 | iex

  With options, e.g. without the autostart question:
    & ([scriptblock]::Create((irm https://github.com/EndreJordal/ipman/releases/latest/download/install.ps1))) -NoAutostart

  Options:
    -Autostart / -NoAutostart  answer "start ipman when you log in?" in advance
    -Uninstall                 remove ipman (also: Settings > Apps > Installed apps > ipman)
    -Path <folder>             install folder (default: %LOCALAPPDATA%\Programs\ipman)
    -Port <number>             port (default 5173). Updates keep the port of the existing install:
                               the browser stores settings per port, so changing it looks like a
                               fresh install.

  What it does: downloads the ipman package from GitHub, Node.js from nodejs.org and ffmpeg
  from gyan.dev, checks every download against its published SHA-256 checksum, and installs
  them into one folder. Nothing is installed system-wide and nothing is added to the PATH.
  Settings and favorites live in your browser and survive updates.

  (Plain ASCII on purpose: Windows PowerShell 5.1 can garble other characters in downloaded
  scripts. No `exit` either: under `irm | iex` it would close your PowerShell window.)
#>
param(
  [string]$Path = (Join-Path $env:LOCALAPPDATA 'Programs\ipman'),
  [switch]$Autostart,
  [switch]$NoAutostart,
  [switch]$Uninstall,
  # 0: keep the existing install's port, or 5173 for a new install.
  [int]$Port = 0,
  # For testing: install from a local folder or another URL, without starting.
  [string]$Source = 'https://github.com/EndreJordal/ipman/releases/latest/download',
  [switch]$NoStart,
  [switch]$NoBrowser
)

# Everything runs in a child scope, so nothing here changes the caller's PowerShell session.
& {
 try {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue' # the progress bar makes downloads many times slower in PowerShell 5.1
  # Older Windows 10 installs don't enable TLS 1.2 by default, which GitHub and nodejs.org require.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $NodeVersion = '24.19.0'
  $FfmpegZipUrl = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'

  function Say([string]$Text) { Write-Host "  $Text" }
  function Step([string]$Text) { Write-Host ''; Write-Host "> $Text" -ForegroundColor Cyan }

  # ---------- Where things go ----------

  $Path = [IO.Path]::GetFullPath($Path)
  $windowsDir = [IO.Path]::GetFullPath($env:windir)
  if ($Path.StartsWith($windowsDir, [StringComparison]::OrdinalIgnoreCase) -or $Path -eq [IO.Path]::GetPathRoot($Path)) {
    throw "Refusing to install into '$Path'. Pick a normal folder, or leave out -Path to use the default."
  }
  $AppDir = Join-Path $Path 'app'
  $NodeExe = Join-Path $Path 'node\node.exe'
  $FfmpegExe = Join-Path $Path 'ffmpeg\ffmpeg.exe'
  $ServerJs = Join-Path $AppDir 'server.mjs'
  $DataDir = Join-Path $env:LOCALAPPDATA 'ipman'
  $StartMenuLink = Join-Path ([Environment]::GetFolderPath('Programs')) 'ipman.lnk'
  $StartupLink = Join-Path ([Environment]::GetFolderPath('Startup')) 'ipman.lnk'
  $UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ipman'
  $Conhost = Join-Path $env:windir 'System32\conhost.exe'
  # The port an existing install uses, remembered in install.json, wins over the default.
  $InstallInfo = Join-Path $Path 'install.json'
  $previousPort = 0
  if (Test-Path -LiteralPath $InstallInfo) {
    try { $previousPort = [int](Get-Content -LiteralPath $InstallInfo -Raw | ConvertFrom-Json).port } catch { $previousPort = 0 }
  }
  if ($Port -eq 0) { if ($previousPort -gt 0) { $Port = $previousPort } else { $Port = 5173 } }
  if ($Port -lt 1 -or $Port -gt 65535) { throw "Invalid port $Port." }
  $Url = "http://127.0.0.1:$Port/"
  $PortArgs = ''
  if ($Port -ne 5173) { $PortArgs = " --port $Port" }

  # The same folder can be written in long form (C:\Users\longname) or short 8.3 form
  # (C:\Users\LONGNA~1), and which one a path ends up in depends on whether the folder existed
  # when it was normalized. Compare paths only after normalizing both sides, when both exist.
  function Test-SamePath([string]$A, [string]$B) {
    if (-not $A -or -not $B) { return $false }
    try { return [IO.Path]::GetFullPath($A) -eq [IO.Path]::GetFullPath($B) } catch { return $false }
  }

  function Stop-Ipman {
    # This install's server: node.exe from the install folder.
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
      Where-Object { Test-SamePath $_.ExecutablePath $NodeExe } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }

  function Remove-GitVersionAutostart {
    # The Git checkout version (scripts/autostart.ps1) ran as a scheduled task named "ipman" on the
    # same port. Remove it so the two don't fight over port 5173.
    $task = Get-ScheduledTask -TaskName 'ipman' -ErrorAction SilentlyContinue
    if (-not $task) { return }
    Stop-ScheduledTask -TaskName 'ipman' -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName 'ipman' -Confirm:$false
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
      Where-Object { $_.CommandLine -match 'server[\\/]index\.ts' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Say 'Removed the autostart of the old Git version (scheduled task "ipman").'
  }

  function New-Shortcut([string]$LinkPath, [string]$Arguments, [string]$Description) {
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($LinkPath)
    # conhost --headless runs node without any console window.
    $link.TargetPath = $Conhost
    $link.Arguments = "--headless `"$NodeExe`" `"$ServerJs`"$Arguments"
    $link.WorkingDirectory = $Path
    $link.IconLocation = (Join-Path $AppDir 'ipman.ico')
    $link.Description = $Description
    $link.Save()
  }

  function Get-Download([string]$From, [string]$To) {
    if (Test-Path -LiteralPath $From) { Copy-Item -LiteralPath $From -Destination $To; return } # local folder (testing)
    try { Invoke-WebRequest -Uri $From -OutFile $To -UseBasicParsing }
    catch { throw "Could not download $From ($($_.Exception.Message)). Check your internet connection and try again." }
  }

  function Assert-Checksum([string]$File, [string]$Expected, [string]$What) {
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $File).Hash
    if ($actual -ne $Expected.Trim()) {
      throw "The $What download is corrupt or has been tampered with (SHA-256 mismatch). Nothing was changed. Try again later."
    }
  }

  function Wait-Server([int]$Seconds) {
    for ($i = 0; $i -lt ($Seconds * 2); $i++) {
      try {
        $v = Invoke-RestMethod -Uri "$($Url)version" -TimeoutSec 2 -UseBasicParsing
        if ($v.version) { return $v.version }
      } catch { Start-Sleep -Milliseconds 500 }
    }
    return $null
  }

  Write-Host ''
  Write-Host 'ipman installer' -ForegroundColor Green

  # ---------- Uninstall ----------

  if ($Uninstall) {
    Step 'Removing ipman'
    Stop-Ipman
    foreach ($item in @($StartMenuLink, $StartupLink)) { Remove-Item -LiteralPath $item -Force -ErrorAction SilentlyContinue }
    Remove-Item -Path $UninstallKey -Recurse -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500 # let the stopped server release its files
    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $DataDir -Recurse -Force -ErrorAction SilentlyContinue
    Say "Removed $Path, its shortcuts and its cache."
    Say 'Your ipman settings and favorites are stored in your browser; clear the site data for 127.0.0.1 to remove them too.'
    return
  }

  # ---------- Questions first, so the rest runs unattended ----------

  $installed = $null
  $versionFile = Join-Path $AppDir 'version.json'
  if (Test-Path -LiteralPath $versionFile) { $installed = (Get-Content -LiteralPath $versionFile -Raw | ConvertFrom-Json).version }
  if ($installed) { Say "Updating the ipman $installed in $Path" } else { Say "Installing into $Path" }

  if ($Autostart) { $wantAutostart = $true }
  elseif ($NoAutostart) { $wantAutostart = $false }
  else {
    # Default: keep the current choice on updates; yes for new installs.
    $default = (Test-Path -LiteralPath $StartupLink) -or (-not $installed)
    $hint = if ($default) { '[Y/n]' } else { '[y/N]' }
    $wantAutostart = $default
    while ($true) {
      try { $answer = Read-Host "  Start ipman automatically when you log in? $hint" }
      catch { break } # no interactive console: keep the default
      $answer = "$answer".Trim().ToLower()
      if ($answer -eq '') { break }
      if ($answer -in @('y', 'yes')) { $wantAutostart = $true; break }
      if ($answer -in @('n', 'no')) { $wantAutostart = $false; break }
      Say 'Please answer y or n.'
    }
  }

  # ---------- Download and verify (nothing is changed until all downloads check out) ----------

  $tmp = Join-Path $env:TEMP ('ipman-install-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    Step 'Downloading ipman'
    $zip = Join-Path $tmp 'ipman.zip'
    Get-Download "$Source/ipman.zip" $zip
    Get-Download "$Source/ipman.zip.sha256" "$zip.sha256"
    Assert-Checksum $zip ((Get-Content -LiteralPath "$zip.sha256" -Raw) -split '\s+')[0] 'ipman'
    Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $tmp 'app')
    $newVersion = (Get-Content -LiteralPath (Join-Path $tmp 'app\version.json') -Raw | ConvertFrom-Json).version
    Say "ipman $newVersion (checksum OK)"

    $needNode = $true
    if (Test-Path -LiteralPath $NodeExe) {
      try { $needNode = (& $NodeExe --version) -ne "v$NodeVersion" } catch { $needNode = $true }
    }
    if ($needNode) {
      Step "Downloading Node.js $NodeVersion from nodejs.org (about 30 MB)"
      $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
      $nodeZipName = "node-v$NodeVersion-win-$arch.zip"
      $nodeZip = Join-Path $tmp $nodeZipName
      Get-Download "https://nodejs.org/dist/v$NodeVersion/$nodeZipName" $nodeZip
      Get-Download "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" (Join-Path $tmp 'SHASUMS256.txt')
      $line = Get-Content -LiteralPath (Join-Path $tmp 'SHASUMS256.txt') | Where-Object { $_ -match "\s$([regex]::Escape($nodeZipName))$" }
      if (-not $line) { throw "nodejs.org has no checksum for $nodeZipName." }
      Assert-Checksum $nodeZip (($line -split '\s+')[0]) 'Node.js'
      Expand-Archive -LiteralPath $nodeZip -DestinationPath (Join-Path $tmp 'node')
      Say 'Node.js (checksum OK)'
    }

    $needFfmpeg = -not (Test-Path -LiteralPath $FfmpegExe)
    if ($needFfmpeg) {
      Step 'Downloading ffmpeg from gyan.dev (about 100 MB, this can take a minute)'
      $ffZip = Join-Path $tmp 'ffmpeg.zip'
      Get-Download $FfmpegZipUrl $ffZip
      Get-Download "$FfmpegZipUrl.sha256" "$ffZip.sha256"
      Assert-Checksum $ffZip ((Get-Content -LiteralPath "$ffZip.sha256" -Raw) -split '\s+')[0] 'ffmpeg'
      Expand-Archive -LiteralPath $ffZip -DestinationPath (Join-Path $tmp 'ffmpeg')
      Say 'ffmpeg (checksum OK)'
    }

    # ---------- Install ----------

    Step 'Installing'
    Stop-Ipman
    if ($Port -eq 5173) { Remove-GitVersionAutostart }
    Start-Sleep -Milliseconds 500 # let a stopped server release its files

    $inUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($inUse) {
      $owner = Get-Process -Id $inUse.OwningProcess -ErrorAction SilentlyContinue
      throw "Port $Port is in use by $($owner.ProcessName) (process $($inUse.OwningProcess)). ipman needs this port: close that program and run the installer again."
    }

    New-Item -ItemType Directory -Force -Path $Path | Out-Null
    if (Test-Path -LiteralPath $AppDir) { Remove-Item -LiteralPath $AppDir -Recurse -Force }
    Move-Item -LiteralPath (Join-Path $tmp 'app') -Destination $AppDir
    if ($needNode) {
      New-Item -ItemType Directory -Force -Path (Split-Path $NodeExe) | Out-Null
      $extracted = Get-ChildItem -LiteralPath (Join-Path $tmp 'node') -Recurse -Filter 'node.exe' | Select-Object -First 1
      Copy-Item -LiteralPath $extracted.FullName -Destination $NodeExe -Force
    }
    if ($needFfmpeg) {
      New-Item -ItemType Directory -Force -Path (Split-Path $FfmpegExe) | Out-Null
      $extracted = Get-ChildItem -LiteralPath (Join-Path $tmp 'ffmpeg') -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
      Copy-Item -LiteralPath $extracted.FullName -Destination $FfmpegExe -Force
    }

    New-Shortcut $StartMenuLink " --open$PortArgs" 'Open ipman'
    Say 'Start menu: ipman'
    if ($wantAutostart) {
      New-Shortcut $StartupLink $PortArgs 'Start the ipman server at login'
      Say 'Starts automatically when you log in (change in Task Manager > Startup apps, or run the installer again).'
    } else {
      Remove-Item -LiteralPath $StartupLink -Force -ErrorAction SilentlyContinue
      Say 'Does not start automatically; open it from the Start menu.'
    }

    # Settings > Apps > Installed apps entry, with a working Uninstall button.
    New-Item -Path $UninstallKey -Force | Out-Null
    $sizeKb = [int]((Get-ChildItem -LiteralPath $Path -Recurse -File | Measure-Object Length -Sum).Sum / 1KB)
    $entry = @{
      DisplayName = 'ipman'
      DisplayVersion = $newVersion
      Publisher = 'ipman'
      DisplayIcon = (Join-Path $AppDir 'ipman.ico')
      InstallLocation = $Path
      UninstallString = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $AppDir 'install.ps1')`" -Uninstall -Path `"$Path`""
      URLInfoAbout = 'https://github.com/EndreJordal/ipman'
    }
    foreach ($name in $entry.Keys) { Set-ItemProperty -Path $UninstallKey -Name $name -Value $entry[$name] }
    foreach ($name in @('NoModify', 'NoRepair')) { Set-ItemProperty -Path $UninstallKey -Name $name -Value 1 -Type DWord }
    Set-ItemProperty -Path $UninstallKey -Name 'EstimatedSize' -Value $sizeKb -Type DWord

    # Remembered for the next update (see -Port).
    @{ port = $Port; version = $newVersion } | ConvertTo-Json | Set-Content -LiteralPath $InstallInfo -Encoding ASCII
    if ($previousPort -gt 0 -and $previousPort -ne $Port) {
      Say "Port changed from $previousPort to ${Port}: the browser keeps settings per port, so ipman starts with empty settings there."
    }
  }
  finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }

  # ---------- Start ----------

  if ($NoStart) { Say 'Installed (not started: -NoStart).'; return }
  Step 'Starting ipman'
  $serverArgs = @('--headless', "`"$NodeExe`"", "`"$ServerJs`"")
  if (-not $NoBrowser) { $serverArgs += '--open' }
  if ($Port -ne 5173) { $serverArgs += @('--port', "$Port") }
  Start-Process -FilePath $Conhost -ArgumentList $serverArgs -WindowStyle Hidden
  $running = Wait-Server 20
  if ($running) {
    Write-Host ''
    Write-Host "Done. ipman $running is running at $Url" -ForegroundColor Green
    Say 'It opened in your browser. Next time, use the Start menu entry "ipman".'
  } else {
    Write-Host ''
    Write-Host 'ipman was installed, but did not start.' -ForegroundColor Yellow
    Say "See the log: $(Join-Path $DataDir 'server.log')"
  }
 }
 catch {
  # A plain message instead of a wall of red text. The PowerShell window stays open.
  Write-Host ''
  Write-Host "ipman could not be installed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host '  Nothing was changed unless the message says otherwise. Run the command again to retry.'
 }
}
