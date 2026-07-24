# ============================================================
#  Tiffin Bot — one-click launcher (Windows PowerShell)
#  Pulls latest code, keeps your .env, installs deps, then
#  starts the BOT and the CLOUDFLARE TUNNEL in two windows.
#
#  Run it by double-clicking deploy\run.bat, or:
#     powershell -ExecutionPolicy Bypass -File .\deploy\run.ps1
# ============================================================
$ErrorActionPreference = "Stop"

# Keep the window open and show the error if anything fails (instead of vanishing).
trap {
  Write-Host "`n============================================================" -ForegroundColor Red
  Write-Host " ERROR: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host " At: $($_.InvocationInfo.PositionMessage)" -ForegroundColor DarkYellow
  Write-Host "============================================================" -ForegroundColor Red
  Read-Host "Press Enter to close"
  exit 1
}

$RepoUrl = "https://github.com/Vipulmtk111/tiffinService.git"

# --- Locate the repo: use the clone this script lives in, else clone into %USERPROFILE% ---
$ScriptDir = Split-Path $MyInvocation.MyCommand.Path -Parent          # ...\deploy
$MaybeRepo = Split-Path $ScriptDir -Parent                            # repo root (if run from inside repo)
if (Test-Path (Join-Path $MaybeRepo ".git")) {
  $RepoDir = $MaybeRepo
} else {
  $RepoDir = Join-Path $env:USERPROFILE "tiffinService"
  if (-not (Test-Path (Join-Path $RepoDir ".git"))) {
    Write-Host "Cloning repo into $RepoDir ..." -ForegroundColor Cyan
    git clone $RepoUrl $RepoDir
  }
}
Set-Location $RepoDir
Write-Host "Repo: $RepoDir" -ForegroundColor Green

# --- 1. Node check ---
try { $null = node --version } catch {
  Write-Host "Node.js not found. Install the LTS from https://nodejs.org and re-run." -ForegroundColor Red; Read-Host "Press Enter to exit"; exit 1
}

# --- 2. Pull latest ---
Write-Host "Pulling latest code..." -ForegroundColor Cyan
git pull

# --- 3. Install dependencies ---
Write-Host "Installing dependencies..." -ForegroundColor Cyan
npm install --omit=dev

# --- 4. .env must exist (NEVER overwritten — it holds your secrets and is not in git) ---
if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "`n.env was missing — created a blank one from the template." -ForegroundColor Yellow
  Write-Host "Fill in your real tokens/keys, then run this again:" -ForegroundColor Yellow
  Write-Host "    notepad `"$RepoDir\.env`"" -ForegroundColor Yellow
  Read-Host "Press Enter to exit"; exit 1
}
Write-Host ".env present (kept as-is)" -ForegroundColor Green

# --- 5. Figure out the port from .env (default 3000) ---
$Port = 3000
$m = Select-String -Path ".env" -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
if ($m) { $Port = [int]$m.Matches.Groups[1].Value }

# --- 6. Ensure cloudflared.exe is available ---
$Cf = Join-Path $RepoDir "cloudflared.exe"
if (-not (Test-Path $Cf)) {
  Write-Host "Downloading cloudflared.exe ..." -ForegroundColor Cyan
  Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile $Cf
}

# --- 7. Launch the BOT in its own window ---
Write-Host "Starting the bot (port $Port)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit","-Command","Set-Location '$RepoDir'; node src/index.js"

# --- 8. Launch the Cloudflare TUNNEL in its own window ---
Start-Sleep -Seconds 2
Write-Host "Starting the Cloudflare tunnel..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit","-Command","Set-Location '$RepoDir'; .\cloudflared.exe tunnel --url http://localhost:$Port"

Write-Host "`n============================================================" -ForegroundColor Green
Write-Host " Bot + tunnel are starting in two new windows." -ForegroundColor Green
Write-Host " In the TUNNEL window, copy the https URL it prints" -ForegroundColor Green
Write-Host " (looks like https://something.trycloudflare.com) and set" -ForegroundColor Green
Write-Host " the Meta webhook to:  https://<that-url>/webhook" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Read-Host "Press Enter to close this launcher window (the two app windows stay open)"
