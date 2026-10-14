# Build the FlexText Segmenter for FLEx shell on Windows (plan §12.1). PowerShell only — no bash,
# WSL or Git Bash is assumed on that machine. ⚠ Never run from a cloud session: this is a LOCAL build.
#
#   powershell -ExecutionPolicy Bypass -File desktop\build\build.ps1 [-Python py] [-Clean]
#
# Steps: a venv from requirements.lock (pinned with hashes) → stage the engine → PyInstaller --onedir
# (onefile unpacks to %TEMP% every launch, is slow and trips antivirus with pythonnet) → zip the
# folder. LibLCM is NOT bundled: fwfind.py loads FLEx's own DLLs from its install folder at run time,
# so the model version always matches the user's FLEx. Unsigned, like the Electron test build:
# SmartScreen warns on first run.
param(
  [string]$Python = "py -3.13",
  [switch]$Clean
)
$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Repo = Resolve-Path (Join-Path $Here "..\..")
$Desktop = Join-Path $Repo "desktop"
$Venv = Join-Path $Desktop ".venv"
$Dist = Join-Path $Here "dist"

if ($Clean) {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Venv, $Dist, (Join-Path $Here "build"), (Join-Path $Here "engine")
}
if (-not (Test-Path $Venv)) {
  & $Python.Split(" ") -m venv $Venv
}
$Py = Join-Path $Venv "Scripts\python.exe"
& $Py -m pip install --upgrade pip
& $Py -m pip install --require-hashes -r (Join-Path $Desktop "requirements.lock")

# release stamp: copy-only unless Seth's explicit release stamp is placed beside the exe (plan §12.3)
& $Py (Join-Path $Here "stage_engine.py") --out (Join-Path $Here "engine")

& $Py -m pytest (Join-Path $Desktop "tests") -q
if ($LASTEXITCODE -ne 0) { throw "tests failed; not building" }

& $Py -m PyInstaller --noconfirm --clean --distpath $Dist --workpath (Join-Path $Here "build") (Join-Path $Here "flexshell.spec")
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }

$Ver = (Get-Content (Join-Path $Here "engine\engine-version.json") | ConvertFrom-Json).engineVersion
$Zip = Join-Path $Dist ("FlexTextSegmenterFLEx-" + $Ver + "-win-x64.zip")
if (Test-Path $Zip) { Remove-Item $Zip }
Compress-Archive -Path (Join-Path $Dist "FlexTextSegmenterFLEx\*") -DestinationPath $Zip
Write-Host "built $Zip (copy-only build; see desktop/README.md for the release stamp)"
