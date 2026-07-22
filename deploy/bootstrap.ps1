# ============================================================
#  Tiffin Bot — BOOTSTRAP for a fresh Windows server
#  Installs Git + Node.js if missing, clones the repo, then
#  hands off to deploy\run.ps1 (pull + start bot + tunnel).
#
#  Run in an ADMIN PowerShell:
#     powershell -ExecutionPolicy Bypass -File .\bootstrap.ps1
#  or, if the repo is public, one line:
#     irm https://raw.githubusercontent.com/Vipulmtk111/tiffinService/main/deploy/bootstrap.ps1 | iex
# ============================================================
$ErrorActionPreference = "Stop"
$RepoUrl = "https://github.com/Vipulmtk111/tiffinService.git"
$RepoDir = Join-Path $env:USERPROFILE "tiffinService"

function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
              [Environment]::GetEnvironmentVariable("Path","User")
}

Write-Host "== Tiffin Bot bootstrap ==" -ForegroundColor Cyan
$useWinget = Have winget

# ---------- 1. Git ----------
if (-not (Have git)) {
  Write-Host "Installing Git..." -ForegroundColor Cyan
  if ($useWinget) {
    winget install --id Git.Git -e --silent --accept-package-agreements --accept-source-agreements
  } else {
    $url = "https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/Git-2.47.1-64-bit.exe"
    $exe = "$env:TEMP\git-setup.exe"
    Invoke-WebRequest $url -OutFile $exe
    Start-Process $exe -ArgumentList "/VERYSILENT","/NORESTART","/SP-","/NORESTART" -Wait
  }
  Refresh-Path
}
if (Have git) { Write-Host ("Git " + (git --version)) -ForegroundColor Green } else { Write-Host "Git install failed — install manually from https://git-scm.com/download/win and re-run." -ForegroundColor Red; Read-Host "Enter to exit"; exit 1 }

# ---------- 2. Node.js LTS ----------
if (-not (Have node)) {
  Write-Host "Installing Node.js LTS..." -ForegroundColor Cyan
  if ($useWinget) {
    winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
  } else {
    $url = "https://nodejs.org/dist/v22.11.0/node-v22.11.0-x64.msi"
    $msi = "$env:TEMP\node-lts.msi"
    Invoke-WebRequest $url -OutFile $msi
    Start-Process msiexec.exe -ArgumentList "/i","`"$msi`"","/qn","/norestart" -Wait
  }
  Refresh-Path
}
if (Have node) { Write-Host ("Node " + (node --version)) -ForegroundColor Green } else { Write-Host "Node install failed — install the LTS from https://nodejs.org and re-run." -ForegroundColor Red; Read-Host "Enter to exit"; exit 1 }

# ---------- 3. Clone or update the repo ----------
if (-not (Test-Path (Join-Path $RepoDir ".git"))) {
  Write-Host "Cloning repo into $RepoDir ..." -ForegroundColor Cyan
  git clone $RepoUrl $RepoDir
} else {
  Write-Host "Repo already present — pulling latest..." -ForegroundColor Cyan
  Set-Location $RepoDir; git pull
}

# ---------- 4. Hand off to the launcher ----------
Write-Host "Handing off to run.ps1 ..." -ForegroundColor Cyan
powershell -ExecutionPolicy Bypass -File (Join-Path $RepoDir "deploy\run.ps1")
