# 🍱 Tiffin Bot — WhatsApp Order Assistant

WhatsApp ordering assistant for a tiffin & snacks shop. The **owner** sets the daily menu by pasting it in plain text (an LLM structures it); **customers order by tapping** an interactive menu — pick items, quantities, review, submit. Everything is stored in Google Sheets and the owner's day is automated. The LLM stays out of the order path; it only structures the owner's menu and answers customer *questions*.

## What it does
- **Owner pastes the daily menu** (exactly like they already do on WhatsApp). An LLM turns it into structured items, pulls prices from a persistent **Catalog** price book, and asks the owner only for any *new* item's price. Owner taps **Confirm** → it broadcasts to all customers.
- **Customers order by tapping**, no messy typing: interactive list → quantity buttons → add more → 🧾 review → ✅ submit. Deterministic items and prices — no LLM guessing, no wrong orders.
- Remembers customer addresses; asks only first-timers.
- Customers who just ask a **question** ("kitne baje delivery?", "aaj khandvi hai?") get an LLM answer from today's menu facts — bulk/complaint/custom queries forward to the owner.
- **Cutoff** → kitchen totals (what to cook) + numbered delivery list with addresses to owner.
- **Evening** → per-customer bill with UPI link; one polite reminder next morning.
- **Night** → daily summary (orders, items, revenue, collected, pending, best-seller) + DailyLog row.
- Owner commands: paste-a-menu, `list`, `paid <name>`, `band`/`chalu`, `broadcast`, `summary`, `help`.

## The owner's day (the loop this bot runs)
1. **08:00** — bot nudges the owner: *"Aaj ka menu paste kar dein"* (or confirms it if already set).
2. Owner **pastes the menu** → bot shows the structured draft with prices. If a new item has no price, bot asks (`Palak Patra 45`). Owner taps **✅ Confirm & Send** → menu saved + **broadcast to all customers**, ordering is live.
3. Customer says *hi/menu* → taps items + quantities → address (first time only) → **Submit**.
4. **Cutoff** — owner gets kitchen totals + numbered delivery list with addresses (also on demand via `list`).
5. **Evening** — each customer gets their bill + UPI link. Owner confirms with `paid <name>`.
6. **Night** — owner gets the day's hisaab and a DailyLog row is written.

Change any time in `.env` (`MENU_REMINDER_TIME`, `MENU_BROADCAST_TIME`, `ORDER_CUTOFF`, `PAYMENT_MESSAGE_TIME`, `SUMMARY_TIME`).

## Data model (Google Sheet tabs)
- **Catalog** — persistent price book: `Name | Category | Price | Unit | Active`. Fills up over time so the owner rarely re-enters prices.
- **Menu** — today's available items: `Date | Name | Category | Price | Available`. Rebuilt each day from the owner's paste.
- **Orders** — `Date | Time | Phone | Name | Items | Amount | Address | Status | PaymentStatus | OrderID` (Items = `Bhindi Thali x2 @120 | Thepla x3 @8`).
- **Customers** — `Phone | Name | Address | FirstOrder | LastOrder | TotalOrders`.
- **DailyLog** — `Date | TotalOrders | TotalItems | Revenue | Collected | Pending`.

## Setup (local, ~1 hour first time)

### 1. Install
```bash
npm install
cp .env.example .env
```

### 2. WhatsApp Cloud API (free test number)
1. developers.facebook.com → Create App → type **Business** → add product **WhatsApp**
2. From *WhatsApp → API Setup*: copy the **temporary access token** and **Phone number ID** into `.env`
3. Add your own phone as a recipient (*To* field → Manage phone number list) and send yourself the hello_world template once to open the 24h window
> Test tokens expire every ~24h. For long-running use, create a System User token (Business Settings → System Users) — permanent.

### 3. Free LLM keys
- Gemini: https://aistudio.google.com → Get API key → `LLM_API_KEY`
- Groq: https://console.groq.com → API Keys → `FALLBACK_LLM_API_KEY`

### 4. Google Sheet
1. console.cloud.google.com → new project → enable **Google Sheets API**
2. IAM → Service Accounts → create → Keys → add JSON key → download
3. From the JSON: `client_email` → `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `private_key` → `GOOGLE_PRIVATE_KEY` (keep quotes and \n)
4. Create a blank Google Sheet, **share it with the service account email (Editor)**, put its ID (from URL) in `SHEET_ID`
5. `npm run setup-sheet` — creates all tabs, headers, and a seeded **Catalog** price book

### 5. Test the logic WITHOUT WhatsApp first
```bash
npm test
```
Runs the offline integration test (stubs Sheets, WhatsApp and the LLM) covering the full owner menu-set flow and the customer tap-to-order cart. All checks should pass.

### 6. Connect real WhatsApp (local)
```bash
npm start
# in a second terminal:
cloudflared tunnel --url http://localhost:3000
```
Copy the https URL → Meta App → WhatsApp → Configuration → Webhook:
- Callback URL: `https://<your-tunnel-url>/webhook`
- Verify token: value of `WHATSAPP_VERIFY_TOKEN` from `.env`
- Subscribe to the **messages** field
Now WhatsApp the test number from your phone. 🎉

## Deploy to AWS Linux server
```bash
# on the server
sudo yum install -y nodejs npm   # or apt-get on Ubuntu
sudo npm i -g pm2
# copy project (git clone or scp), then:
cd tiffin-bot && npm install --omit=dev
cp .env.example .env && nano .env   # production values
npm run setup-sheet                  # if using a fresh sheet
pm2 start ecosystem.config.js && pm2 save && pm2 startup
```
HTTPS (required by Meta): point a domain/subdomain A-record at the server IP, open ports 80/443 in the AWS security group, then either
- **Caddy** (easiest): install caddy, `Caddyfile` = `yourdomain.com { reverse_proxy localhost:3000 }` — auto-HTTPS, done; or
- nginx + certbot.
Then set the Meta webhook URL to `https://yourdomain.com/webhook`.

## Going live with real customers
1. Buy a fresh SIM (number NOT on WhatsApp) → add it as a real number in Meta Business Manager
2. Create + submit a `daily_menu` template (needed to broadcast to customers inactive >24h); once approved, switch `broadcastMenu()` in `src/jobs.js` to `sendTemplate` per the comment there
3. Each morning the owner gets the 08:00 nudge and just pastes the day's menu — the bot structures it, confirms, and auto-broadcasts to all customers

## Config
All times, shop name, UPI ID live in `.env` — no code edits needed for business changes. Item names/prices live in the **Catalog** tab (the price book) and are learned automatically as the owner sets menus.

## v1 limitations (by design)
Text messages only (no voice/images) • no payment gateway verification (owner confirms with `paid <name>`) • no geo-radius validation • single shop.
