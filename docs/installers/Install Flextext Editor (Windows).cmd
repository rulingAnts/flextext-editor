<# :
@echo off
title Flextext Editor installer
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; iex (Get-Content -LiteralPath '%~f0' -Raw)"
echo.
pause
exit /b
#>

# ============================================================================
# Flextext Editor — Windows installer
#
# Double-click this file. It will:
#   1. Create "Flextext Editor" app shortcuts (Desktop + Start Menu) that open
#      the app in its own window using Microsoft Edge, with the Research tab
#      disabled (?research=off).
#   2. Launch the app once (this also makes it work offline afterwards).
#   3. Open Windows Settings on the default-browser page — click the
#      "Set default" button next to Microsoft Edge to finish.
#      (Windows does not allow scripts to change the default browser for you.)
#
# To pin to the taskbar: while the app is open, right-click its taskbar icon
# and choose "Pin to taskbar". (Windows blocks scripts from doing this too.)
# ============================================================================

$AppName = 'Flextext Editor'
$AppUrl  = 'https://rulingants.github.io/flextext-editor/?research=off'
$IconUrl = 'https://rulingants.github.io/flextext-editor/icons/icon.ico'

Write-Host ''
Write-Host "=== $AppName installer ===" -ForegroundColor Cyan

# --- Locate Microsoft Edge -------------------------------------------------
$edge = @(
  (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if (-not $edge) {
  Write-Host 'Microsoft Edge was not found on this computer.' -ForegroundColor Red
  Write-Host 'Install Edge first (or ask your researcher for help), then run this again.'
  return
}
Write-Host "Found Microsoft Edge: $edge"

# --- Download the app icon (falls back to the Edge icon if offline) --------
$dataDir = Join-Path $env:LOCALAPPDATA 'FlextextEditor'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$icon = Join-Path $dataDir 'flextext.ico'
try {
  Invoke-WebRequest -Uri $IconUrl -OutFile $icon -UseBasicParsing
  Write-Host 'Downloaded app icon.'
} catch {
  Write-Host 'Could not download the icon (offline?) — using the Edge icon instead.' -ForegroundColor Yellow
  $icon = $edge
}

# --- Create shortcuts -------------------------------------------------------
function New-AppShortcut([string]$path) {
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($path)
  $sc.TargetPath = $edge
  $sc.Arguments = "--app=`"$AppUrl`""
  $sc.WorkingDirectory = (Split-Path $edge)
  $sc.IconLocation = "$icon,0"
  $sc.Description = $AppName
  $sc.Save()
}

$desktopLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) "$AppName.lnk"
New-AppShortcut $desktopLnk
Write-Host "Created Desktop shortcut:    $desktopLnk"

$startDir = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Microsoft\Windows\Start Menu\Programs'
$startLnk = Join-Path $startDir "$AppName.lnk"
New-AppShortcut $startLnk
Write-Host "Created Start Menu shortcut: $startLnk"

# --- Launch the app once (primes the offline cache, applies research=off) ---
Write-Host 'Opening the app...'
Start-Process -FilePath $edge -ArgumentList "--app=`"$AppUrl`""

# --- Default browser: one manual click required ------------------------------
Write-Host ''
Write-Host 'LAST STEP: a Windows Settings window will now open.' -ForegroundColor Cyan
Write-Host 'Click the "Set default" button next to Microsoft Edge.' -ForegroundColor Cyan
Start-Sleep -Seconds 2
try {
  Start-Process 'ms-settings:defaultapps?registeredAppMachine=Microsoft Edge'
} catch {
  Start-Process 'ms-settings:defaultapps'
}

Write-Host ''
Write-Host 'Done! Tip: with the app open, right-click its taskbar icon and'
Write-Host 'choose "Pin to taskbar" so it is always one click away.'
