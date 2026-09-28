<#
  Runs the ipman server (npm start) hidden in the background, starting at logon.

  Usage (or via npm run autostart:<action>):
    autostart.ps1 install     Register the logon task and start the server now
    autostart.ps1 uninstall   Stop the server and remove the task
    autostart.ps1 restart     Restart the server, e.g. after changing the code
    autostart.ps1 status      Show task state, whether the server responds, and the log tail
#>
param(
  [Parameter(Mandatory)]
  [ValidateSet('install', 'uninstall', 'restart', 'status')]
  [string]$Action
)

$ErrorActionPreference = 'Stop'
$TaskName = 'ipman'
$Root = Split-Path -Parent $PSScriptRoot
$Port = 5173
$Url = "http://127.0.0.1:$Port/"
$LogDir = Join-Path $Root '.cache'
$Log = Join-Path $LogDir 'server.log'
$User = "$env:USERDOMAIN\$env:USERNAME"

function Test-Server {
  try {
    Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Stop-Server {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  # Stopping the task can leave node running, so also stop whatever node process holds the port.
  $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($listener in $listeners) {
    $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    if ($process -and $process.ProcessName -eq 'node') { Stop-Process -Id $process.Id -Force }
  }
}

function Start-Server {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host 'Starting ipman' -NoNewline
  for ($i = 0; $i -lt 60; $i++) {
    if (Test-Server) {
      Write-Host "`nipman is running at $Url"
      return
    }
    Write-Host '.' -NoNewline
    Start-Sleep -Milliseconds 500
  }
  Write-Host "`nipman did not respond within 30 seconds. Check the log: $Log"
  exit 1
}

switch ($Action) {
  'install' {
    New-Item -ItemType Directory -Force $LogDir | Out-Null
    # conhost --headless gives npm a console without any window. `powershell -WindowStyle Hidden`
    # is not enough on Windows 11: when Windows Terminal is the default terminal it opens a
    # visible window anyway, and closing that window kills the server.
    $command = "cd /d `"$Root`" && npm start > .cache\server.log 2>&1"
    $taskAction = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless cmd.exe /d /c `"$command`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
    $settings = New-ScheduledTaskSettingsSet `
      -ExecutionTimeLimit ([TimeSpan]::Zero) `
      -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
      -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger -Settings $settings `
      -Principal $principal -Description 'ipman IPTV viewer (npm start)' -Force | Out-Null
    Write-Host "Registered task '$TaskName': ipman now starts hidden when you log in."
    Stop-Server
    Start-Server
  }
  'uninstall' {
    Stop-Server
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed task '$TaskName'. ipman no longer starts at logon."
  }
  'restart' {
    Stop-Server
    Start-Server
  }
  'status' {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) { Write-Host "Task:   $($task.State)" } else { Write-Host 'Task:   not installed (run npm run autostart:install)' }
    if (Test-Server) { Write-Host "Server: responding at $Url" } else { Write-Host 'Server: not responding' }
    if (Test-Path $Log) {
      Write-Host "Log:    $Log"
      Get-Content $Log -Tail 10 | ForEach-Object { Write-Host "  $_" }
    }
  }
}
