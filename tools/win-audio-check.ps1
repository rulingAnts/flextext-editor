<#
  Windows capture check for the Flextext desktop shell.

  WHY THIS EXISTS: the desktop shell's capture path is ffmpeg + dshow. Everything above it (Electron,
  the bridge, the engine) can be excluded by testing ffmpeg on its own — no Node, no npm, no ~180 MB
  of Electron over a field connection. If this passes, native capture is viable on the machine and
  any remaining failure is in packaging or plumbing. If it fails, it fails here with a reason.

  It runs the EXACT arguments src/audio.js builds, so a pass means the real code path works.

  Designed for a glitchy link: everything goes to a log file, and the last line is a DONE marker, so
  a dropped SSH session never loses the result — reconnect and read the file.

  Usage (from the machine under test):
    powershell -NoProfile -ExecutionPolicy Bypass -File win-audio-check.ps1
  Result: %USERPROFILE%\flextext-audio-check.log
#>

$ErrorActionPreference = 'Continue'
$log = Join-Path $env:USERPROFILE 'flextext-audio-check.log'
"" | Set-Content $log
function W($m) { $m | Add-Content $log }

W "=== flextext windows capture check ==="
W ("when      : " + (Get-Date -Format o))
W ("machine   : " + $env:COMPUTERNAME + "  user=" + $env:USERNAME)

$ff = (Get-Command ffmpeg -ErrorAction SilentlyContinue)
if (-not $ff) { W "ffmpeg    : MISSING from PATH"; W "DONE"; exit 1 }
W ("ffmpeg    : " + $ff.Source)

# 1. Enumerate, exactly as listDevicesUncached() does.
W ""
W "--- device enumeration (raw ffmpeg output) ---"
$enum = & ffmpeg -hide_banner -f dshow -list_devices true -i dummy 2>&1 | Out-String
W $enum

# The regex from src/audio.js, character for character.
$names = [regex]::Matches($enum, '"([^"]+)"\s*\(audio\)') | ForEach-Object { $_.Groups[1].Value }
W "--- parsed by OUR regex ---"
if ($names.Count -eq 0) { W "NO AUDIO DEVICES PARSED — the parser is the problem" }
else { $names | ForEach-Object { W ("  device: " + $_) } }

if ($names.Count -eq 0) { W "DONE"; exit 1 }

# 2. Actually capture, with the exact arguments src/audio.js uses for the default format.
$dev = $names[0]
$out = Join-Path $env:USERPROFILE 'flextext-capture-test.wav'
Remove-Item $out -ErrorAction SilentlyContinue
W ""
W ("--- 3s capture test from: " + $dev + " ---")
W "args: -hide_banner -nostdin -flush_packets 1 -f dshow -i audio=<dev> -ac 1 -ar 48000 -c:a pcm_s24le -t 3"

$cap = & ffmpeg -hide_banner -nostdin -flush_packets 1 -f dshow -i ("audio=" + $dev) `
        -ac 1 -ar 48000 -c:a pcm_s24le -t 3 -y $out 2>&1 | Out-String
W $cap

if (Test-Path $out) {
  $f = Get-Item $out
  W ("RESULT: wrote " + $f.Length + " bytes")
  # A WAV header alone is 44 bytes; anything near that captured no audio.
  if ($f.Length -gt 100000) { W "RESULT: PLAUSIBLE AUDIO — native capture works on this machine" }
  else { W "RESULT: FILE TOO SMALL — the device opened but produced (almost) no samples" }
  $b = [System.IO.File]::ReadAllBytes($out)[0..43]
  W ("header: " + ([System.Text.Encoding]::ASCII.GetString($b[0..3])) + " / " +
     ([System.Text.Encoding]::ASCII.GetString($b[8..11])) +
     "  bits=" + [BitConverter]::ToUInt16($b, 34) +
     "  rate=" + [BitConverter]::ToUInt32($b, 24) +
     "  ch="   + [BitConverter]::ToUInt16($b, 22))
} else {
  W "RESULT: NO FILE PRODUCED — capture failed; the ffmpeg output above says why"
}

W ""
W "DONE"
