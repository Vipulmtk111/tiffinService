# Windows Server — pull & run

## Easiest: one-click launcher
After the repo is cloned once, just **double-click `deploy\run.bat`** (or copy `run.bat` + `run.ps1` to the desktop and double-click). It:
1. pulls the latest code from GitHub,
2. keeps your existing `.env` untouched (never overwrites your secrets),
3. installs dependencies,
4. downloads `cloudflared.exe` if missing,
5. starts the **bot** and the **Cloudflare tunnel** each in its own window.

Then copy the `https://….trycloudflare.com` URL from the tunnel window and set the Meta webhook to `https://<that-url>/webhook`.

> ⚠️ A free "quick tunnel" URL **changes every time** you restart it — you'd have to update the Meta webhook each run. For a permanent URL, use a **named Cloudflare tunnel** (or a domain + reverse proxy). Ask and I'll add a named-tunnel script.

### First-time clone (paste once on the server)
```powershell
cd $HOME
git clone https://github.com/Vipulmtk111/tiffinService.git
cd tiffinService
powershell -ExecutionPolicy Bypass -File .\deploy\run.ps1
```
(The `git clone` needs GitHub auth for the private repo — run `gh auth login` first, or use a Personal Access Token as the password.)

---

## Alternative: pm2 service (no tunnel) — `server-setup.ps1`

## First time (clone)
Open **PowerShell** on the server and run:
```powershell
git clone https://github.com/Vipulmtk111/tiffinService.git
cd tiffinService
powershell -ExecutionPolicy Bypass -File .\deploy\server-setup.ps1
```
The first run creates `.env` from the template and stops so you can fill it in:
```powershell
notepad .env      # paste your real WHATSAPP_TOKEN, LLM_API_KEY, GOOGLE_PRIVATE_KEY, SHEET_ID, etc.
```
Then run the script again to install, test, and start:
```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\server-setup.ps1
```

## Every update after that
When new code is pushed, on the server just run:
```powershell
cd tiffinService
powershell -ExecutionPolicy Bypass -File .\deploy\server-setup.ps1
```
This pulls, installs (if needed), runs the test, and restarts the bot via pm2.

## Notes
- **`.env` is never in Git** (it holds secrets). It lives only on the server — keep a private backup.
- **pm2** keeps the bot running and auto-restarts it. Install once: `npm i -g pm2`.
  - To start on server reboot: `pm2 startup` (follow the printed command), then `pm2 save`.
- **Webhook (Meta):** the bot listens on port 3000. Meta requires HTTPS, so put a reverse proxy (IIS/Caddy/nginx) with a domain in front, or use a Cloudflare tunnel, and set the Meta webhook callback to `https://<your-domain>/webhook`.
- Handy pm2 commands: `pm2 logs tiffin-bot`, `pm2 restart tiffin-bot`, `pm2 stop tiffin-bot`, `pm2 status`.
