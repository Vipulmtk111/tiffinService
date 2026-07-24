# Tiffin Bot - one-shot server setup / update script (Windows PowerShell)
# Run from INSIDE the cloned repo folder:
#     powershell -ExecutionPolicy Bypass -File .\deploy\server-setup.ps1
# It pulls latest code, installs deps, checks .env, runs the test, and (re)starts the bot with pm2.

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)   # repo root
Write-Host "== Tiffin Bot setup ==" -ForegroundColor Cyan

# 1. Node check
try { $node = node --version } catch { Write-Host "Node.js not found. Install from https://nodejs.org (LTS), then re-run." -ForegroundColor Red; exit 1 }
Write-Host "Node $node" -ForegroundColor Green

# 2. Pull latest (skip if not a git repo yet)
if (Test-Path ".git") { Write-Host "Pulling latest..." -ForegroundColor Cyan; git pull }

# 3. Install dependencies
Write-Host "Installing dependencies..." -ForegroundColor Cyan
npm install --omit=dev

# 4. .env check (must be created manually - it holds secrets and is NOT in git)
if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "`n.env was missing - created it from .env.example." -ForegroundColor Yellow
  Write-Host "EDIT .env now with your real tokens/keys, then re-run this script:" -ForegroundColor Yellow
  Write-Host "    notepad .env" -ForegroundColor Yellow
  exit 1
}
Write-Host ".env present" -ForegroundColor Green

# 5. Sanity test (offline, no WhatsApp needed)
Write-Host "Running offline test..." -ForegroundColor Cyan
npm test

# 6. Start / restart with pm2 (falls back to plain node if pm2 is absent)
$hasPm2 = $null -ne (Get-Command pm2 -ErrorAction SilentlyContinue)
if ($hasPm2) {
  Write-Host "Starting with pm2..." -ForegroundColor Cyan
  pm2 start ecosystem.config.js --update-env
  pm2 save
  Write-Host "`nDone. Bot is running under pm2. Logs: pm2 logs tiffin-bot" -ForegroundColor Green
} else {
  Write-Host "`npm2 not installed (recommended: npm i -g pm2)." -ForegroundColor Yellow
  Write-Host "Starting once in this window instead (closes when you close it):" -ForegroundColor Yellow
  node src/index.js
}
