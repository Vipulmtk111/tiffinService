const cron = require("node-cron");
const cfg = require("./config");
const sheets = require("./sheets");
const wa = require("./whatsapp");
const { renderMenu, sendMenuTo } = require("./logic");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Track which date's menu we've already broadcast so the scheduled job and the
// owner's manual/auto broadcast never double-send to customers on the same day.
let lastBroadcastDate = null;
function markBroadcast(dateStr = sheets.todayStr()) { lastBroadcastDate = dateStr; }
function alreadyBroadcast(dateStr = sheets.todayStr()) { return lastBroadcastDate === dateStr; }

// 0) Morning nudge: remind the owner to set TODAY's menu (or confirm it if already set).
async function menuReminder() {
  const menu = await sheets.getMenu();
  const owner = cfg.biz.ownerPhone;
  if (menu && menu.length) {
    return wa.sendText(owner,
      `🌅 Good morning! Aaj ka menu already set hai:\n\n${renderMenu(menu)}\n\n` +
      `Customers ko dobara bhejne ke liye "broadcast" bhejein.\nBadalna ho toh naya menu paste kar dein.`);
  }
  return wa.sendText(owner,
    `🌅 Good morning! Aaj ka menu abhi set nahi hua.\n\n` +
    `Bas apna aaj ka menu paste kar dein 📋 Main draft bana ke confirm maangunga, phir customers ko bhej dunga. 🍱\n\n` +
    `Format dekhne ke liye "format" bhejein.`);
}

// 1) Menu broadcast to all customers (individual messages, ~1/sec throttle)
async function broadcastMenu({ force = false } = {}) {
  const menu = await sheets.getMenu();
  if (!menu || !menu.length) return wa.sendText(cfg.biz.ownerPhone, `⚠️ Aaj ka menu set nahi hai! Apna menu paste kar dein.`);
  if (!force && alreadyBroadcast()) {
    return wa.sendText(cfg.biz.ownerPhone, `ℹ️ Aaj ka menu already broadcast ho chuka hai. Dobara bhejne ke liye "broadcast" bhejein.`);
  }
  const customers = await sheets.getAllCustomers();
  let sent = 0;
  for (const c of customers) {
    // The same tappable menu a customer gets on "hi" — so the broadcast itself is
    // orderable, instead of plain text pointing at a button that isn't there.
    // NOTE: interactive messages, like free-form text, only reach customers active
    // in the last 24h. For the rest, create+approve a 'daily_menu' template in Meta
    // Business Manager and send that first to reopen the window.
    await sendMenuTo(c.phone, menu);
    sent++;
    await sleep(1100);
  }
  markBroadcast();
  await wa.sendText(cfg.biz.ownerPhone, `📣 Menu broadcast done — ${sent} customers.`);
}

// 2) Kitchen + delivery list at cutoff
async function kitchenList() {
  const orders = (await sheets.getOrders()).filter((o) => o.status === "confirmed");
  const b = cfg.biz;
  // Aggregate every line item across all orders for the kitchen.
  const totals = {};
  for (const o of orders) for (const it of o.items) totals[it.name] = (totals[it.name] || 0) + it.qty;
  const kitchenLines = Object.entries(totals).map(([k, v]) => `${k} ×${v}`).join("\n") || "—";
  const revenue = orders.reduce((n, o) => n + o.amount, 0);

  let msg = `📋 AAJ KA ORDER (${b.orderCutoff})\nTotal orders: ${orders.length} | Revenue: ₹${revenue}\n\n👨‍🍳 KITCHEN (banana hai):\n${kitchenLines}\n\n🛵 DELIVERY LIST:`;
  orders.forEach((o, i) => {
    const items = o.items.map((it) => `${it.qty}× ${it.name}`).join(", ");
    msg += `\n${i + 1}. ${o.name || o.phone} — ${items} — ₹${o.amount}\n   📍 ${o.address || "address?"} | ${o.payment === "paid" ? "✅ paid" : "💸 pending"}`;
  });
  if (!orders.length) msg += "\n(koi order nahi aaj)";
  await wa.sendText(cfg.biz.ownerPhone, msg);
}

// 3) Payment requests in the evening
async function paymentRequests() {
  const b = cfg.biz;
  const unpaid = (await sheets.getOrders()).filter((o) => o.status === "confirmed" && o.payment === "pending");
  for (const o of unpaid) {
    const upiLink = `upi://pay?pa=${encodeURIComponent(b.upiId)}&pn=${encodeURIComponent(b.shopName)}&am=${o.amount}&cu=INR`;
    const items = o.items.map((it) => `${it.qty}× ${it.name}`).join(", ");
    await wa.sendText(o.phone, `Aaj ka bill 🍱\n${items} = ₹${o.amount}\nUPI: ${b.upiId}\n${upiLink}\nPay karke "done" bhej dein 🙏`);
    await sleep(1100);
  }
  if (unpaid.length) await wa.sendText(b.ownerPhone, `💸 Payment request bheja — ${unpaid.length} customers.`);
}

// 4) One polite reminder next morning for yesterday's unpaid
async function paymentReminders() {
  const y = sheets.todayStr(new Date(Date.now() - 24 * 3600 * 1000));
  const unpaid = (await sheets.getOrders(y)).filter((o) => o.status === "confirmed" && o.payment === "pending");
  for (const o of unpaid) {
    await wa.sendText(o.phone, `Namaste 🙏 kal ka ₹${o.amount} pending hai.\nUPI: ${cfg.biz.upiId}\nJab time mile pay kar dijiyega, dhanyawad 🙂`);
    await sleep(1100);
  }
}

// 5) Daily summary + DailyLog row
async function dailySummary() {
  const orders = (await sheets.getOrders()).filter((o) => o.status === "confirmed");
  const revenue = orders.reduce((n, o) => n + o.amount, 0);
  const collected = orders.filter((o) => o.payment === "paid").reduce((n, o) => n + o.amount, 0);
  const pendingOrders = orders.filter((o) => o.payment !== "paid");
  const pending = revenue - collected;
  const totalItems = orders.reduce((n, o) => n + o.items.reduce((m, it) => m + it.qty, 0), 0);

  // Best-seller line
  const totals = {};
  for (const o of orders) for (const it of o.items) totals[it.name] = (totals[it.name] || 0) + it.qty;
  const top = Object.entries(totals).sort((a, b) => b[1] - a[1])[0];

  const pendList = pendingOrders.map((o) => `${o.name || o.phone} ₹${o.amount}`).join(", ") || "—";
  await wa.sendText(cfg.biz.ownerPhone,
    `📊 AAJ KA HISAAB (${sheets.todayStr()})\nOrders: ${orders.length} | Items: ${totalItems} | Revenue: ₹${revenue}\nReceived: ₹${collected} ✅ | Pending: ₹${pending}\nPending log: ${pendList}` +
    (top ? `\n🏆 Sabse zyada: ${top[0]} (${top[1]})` : ""));

  await sheets.appendDailyLog({
    date: sheets.todayStr(), totalOrders: orders.length, totalItems, revenue, collected, pending,
  });
}

// Safety-net broadcast at MENU_BROADCAST_TIME: if the owner set the menu but it
// hasn't gone out yet, send it; if it's already out, stay silent; if there's
// still no menu, nudge the owner one more time.
async function scheduledBroadcast() {
  if (alreadyBroadcast()) return; // owner already broadcast after setting menu
  const menu = await sheets.getMenu();
  if (menu && menu.length) return broadcastMenu();
  await wa.sendText(cfg.biz.ownerPhone, `⏰ Reminder: aaj ka menu abhi tak set nahi hua. Apna menu paste kar dein — customers wait kar rahe hain. 🍱`);
}

function toCron(hhmm) { const [h, m] = hhmm.split(":"); return `${Number(m)} ${Number(h)} * * *`; }

function startJobs() {
  const tz = { timezone: cfg.biz.tz };
  const b = cfg.biz;
  cron.schedule(toCron(b.menuReminderTime), () => menuReminder().catch(console.error), tz);
  cron.schedule(toCron(b.menuTime), () => scheduledBroadcast().catch(console.error), tz);
  cron.schedule(toCron(b.orderCutoff), () => kitchenList().catch(console.error), tz);
  cron.schedule(toCron(b.paymentTime), () => paymentRequests().catch(console.error), tz);
  cron.schedule(toCron(b.reminderTime), () => paymentReminders().catch(console.error), tz);
  cron.schedule(toCron(b.summaryTime), () => dailySummary().catch(console.error), tz);
  console.log(`[jobs] scheduled: menu-reminder ${b.menuReminderTime}, broadcast ${b.menuTime}, list ${b.orderCutoff}, payments ${b.paymentTime}, reminder ${b.reminderTime}, summary ${b.summaryTime} (${b.tz})`);
}

module.exports = { startJobs, menuReminder, broadcastMenu, scheduledBroadcast, kitchenList, paymentRequests, paymentReminders, dailySummary, markBroadcast, alreadyBroadcast };
