<#
  Windows capture check for the Flextext desktop shell.

  WHY: the desktop capture path is ffmpeg + dshow. Testing ffmpeg alone excludes Electron, the
  bridge and the engine without installing Node or pulling ~180MB of Electron over a field
  connection. It runs the EXACT arguments src/audio.js builds and applies the EXACT device-name
  regex, so a pass means the real code path works on this machine.

  TWO TRAPS THIS SCRIPT WAS BITTEN BY, both worth keeping in mind for anything similar:

  1. ASCII ONLY. This file is fetched over HTTP and run by powershell.exe. Non-ASCII characters
     (em-dashes, smart quotes) arrived mangled and turned string literals into commands, so the
     script failed in a way that looked like a device problem. Do not reintroduce them.

  2. RUN FFMPEG THROUGH cmd. PowerShell converts a native program's stderr into ErrorRecord
     objects, so "& ffmpeg ... 2>&1 | Out-String" yields PowerShell's error FORMATTING rather than
     ffmpeg's text, complete with line wrapping that splits quoted device names. The regex then
     matches nothing even though the device is plainly listed. "cmd /c ... 2>&1" gives the raw text.

  3. RUN IT IN AN INTERACTIVE OR SSH SESSION, NOT A SCHEDULED TASK. A detached/session-0 task
     cannot enumerate audio devices at all ("Could not enumerate audio only devices"), which looks
     exactly like a machine with no microphone.

  Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File win-audio-check.ps1
  Result: %USERPROFILE%\flextext-audio-check.log  (last line is DONE)
#>

$ErrorActionPreference = 'Continue'
$log = Join-Path $env:USERPROFILE 'flextext-audio-check.log'
"" | Set-Content $log -Encoding ASCII
function W($m) { $m | Add-Content $log -Encoding ASCII }

W "=== flextext windows capture check ==="
W ("when    : " + (Get-Date -Format o))
W ("machine : " + $env:COMPUTERNAME + "  user=" + $env:USERNAME)

$ffCmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffCmd) { W "ffmpeg  : MISSING from PATH"; W "DONE"; exit 1 }
$ff = $ffCmd.Source
W ("ffmpeg  : " + $ff)

# ---- 1. Enumerate, exactly as listDevicesUncached() does -------------------------------------
W ""
W "--- device enumeration (raw) ---"
$enum = cmd /c "`"$ff`" -hide_banner -f dshow -list_devices true -i dummy 2>&1" | Out-String
W $enum

$names = [regex]::Matches($enum, '"([^"]+)"\s*\(audio\)') | ForEach-Object { $_.Groups[1].Value }
W "--- parsed by OUR regex ---"
if ($names.Count -eq 0) {
  W "NO AUDIO DEVICES PARSED. The raw text above shows what the regex was given."
  W "DONE"
  exit 1
}
foreach ($n in $names) { W ("  device: " + $n) }

# ---- 2. Capture for real, with the exact arguments src/audio.js uses --------------------------
$dev = $names[0]
$out = Join-Path $env:USERPROFILE 'flextext-capture-test.wav'
Remove-Item $out -ErrorAction SilentlyContinue
W ""
W ("--- 3s capture test from: " + $dev + " ---")

$args = "-hide_banner -nostdin -flush_packets 1 -f dshow -i `"audio=$dev`" " +
        "-ac 1 -ar 48000 -c:a pcm_s24le -t 3 -y `"$out`""
W ("args: " + $args)
$cap = cmd /c "`"$ff`" $args 2>&1" | Out-String
W $cap

if (Test-Path $out) {
  $len = (Get-Item $out).Length
  W ("RESULT: wrote " + $len + " bytes")
  # 3s of 24-bit 48k mono is ~432000 bytes. A bare WAV header is 44.
  if ($len -gt 100000) { W "RESULT: PLAUSIBLE AUDIO. Native capture WORKS on this machine." }
  else { W "RESULT: FILE TOO SMALL. Device opened but produced almost no samples." }
  $b = [System.IO.File]::ReadAllBytes($out)
  if ($b.Length -ge 44) {
    W ("header: " + [System.Text.Encoding]::ASCII.GetString($b[0..3]) + "/" +
       [System.Text.Encoding]::ASCII.GetString($b[8..11]) +
       "  bits=" + [BitConverter]::ToUInt16($b, 34) +
       "  rate=" + [BitConverter]::ToUInt32($b, 24) +
       "  ch="   + [BitConverter]::ToUInt16($b, 22))
  }
} else {
  W "RESULT: NO FILE PRODUCED. Capture failed; the ffmpeg output above says why."
}

W ""
W "DONE"
