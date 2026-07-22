const { google } = require("googleapis");
const cfg = require("./config");

let sheetsClient = null;
function client() {
  if (!sheetsClient) {
    const auth = new google.auth.JWT({
      email: cfg.sheets.email,
      key: cfg.sheets.key,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    sheetsClient = google.sheets({ version: "v4", auth });
  }
  return sheetsClient;
}

async function withRetry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 800 * (i + 1))); }
  }
  throw last;
}

async function read(range) {
  const res = await withRetry(() =>
    client().spreadsheets.values.get({ spreadsheetId: cfg.sheets.sheetId, range })
  );
  return res.data.values || [];
}
async function append(range, rows) {
  return withRetry(() =>
    client().spreadsheets.values.append({
      spreadsheetId: cfg.sheets.sheetId, range,
      valueInputOption: "USER_ENTERED", requestBody: { values: rows },
    })
  );
}
async function update(range, rows) {
  return withRetry(() =>
    client().spreadsheets.values.update({
      spreadsheetId: cfg.sheets.sheetId, range,
      valueInputOption: "USER_ENTERED", requestBody: { values: rows },
    })
  );
}
async function clear(range) {
  return withRetry(() =>
    client().spreadsheets.values.clear({ spreadsheetId: cfg.sheets.sheetId, range })
  );
}

function todayStr(d = new Date()) {
  return d.toLocaleDateString("en-CA", { timeZone: cfg.biz.tz }); // YYYY-MM-DD
}
function nowTime() {
  return new Date().toLocaleTimeString("en-GB", { timeZone: cfg.biz.tz, hour: "2-digit", minute: "2-digit" });
}

// ---------- Catalog (persistent price book) ----------
// Columns: Name | Category | Price | Unit | Active(Y/N)
async function getCatalog() {
  const rows = await read("Catalog!A2:E500");
  return rows
    .filter((r) => r[0])
    .map((r) => ({
      row: 0, name: r[0], category: r[1] || "Other",
      price: Number(r[2]) || 0, unit: r[3] || "", active: (r[4] || "Y").toUpperCase() !== "N",
    }));
}
// Add unseen items / refresh prices for known ones. items = [{name, category, price, unit}]
async function upsertCatalogItems(items) {
  const rows = await read("Catalog!A2:E500");
  const byName = new Map(rows.map((r, i) => [(r[0] || "").trim().toLowerCase(), i]));
  const updates = [];
  const additions = [];
  for (const it of items) {
    const key = (it.name || "").trim().toLowerCase();
    if (!key) continue;
    const idx = byName.get(key);
    const rowVals = [it.name, it.category || "Other", it.price ?? "", it.unit || "", "Y"];
    if (idx != null) updates.push({ range: `Catalog!A${idx + 2}:E${idx + 2}`, values: [rowVals] });
    else { additions.push(rowVals); byName.set(key, rows.length + additions.length - 1); }
  }
  for (const u of updates) await update(u.range, u.values);
  if (additions.length) await append("Catalog!A2", additions);
}

// ---------- Menu (today's available items) ----------
// Columns: Date | Name | Category | Price | Available(Y/N)
async function getMenu(dateStr = todayStr()) {
  const rows = await read("Menu!A2:E1000");
  const items = rows
    .filter((r) => r[0] === dateStr && r[1] && (r[4] || "Y").toUpperCase() !== "N")
    .map((r) => ({ name: r[1], category: r[2] || "Other", price: Number(r[3]) || 0 }));
  return items.length ? items : null;
}
// Replace the whole menu for a date. items = [{name, category, price}]
async function setMenuItems(dateStr, items) {
  const rows = await read("Menu!A2:E1000");
  const kept = rows.filter((r) => r[0] && r[0] !== dateStr);
  const fresh = items.map((it) => [dateStr, it.name, it.category || "Other", it.price ?? 0, "Y"]);
  await clear("Menu!A2:E1000");
  const all = [...kept, ...fresh];
  if (all.length) await update("Menu!A2", all);
}

// ---------- Customers ----------
async function getCustomer(phone) {
  const rows = await read("Customers!A2:F5000");
  const idx = rows.findIndex((r) => r[0] === phone);
  if (idx < 0) return null;
  const r = rows[idx];
  return { row: idx + 2, phone: r[0], name: r[1] || "", address: r[2] || "", firstOrder: r[3] || "", lastOrder: r[4] || "", totalOrders: Number(r[5]) || 0 };
}
async function upsertCustomer({ phone, name, address }) {
  const existing = await getCustomer(phone);
  const t = todayStr();
  if (existing) {
    return update(`Customers!A${existing.row}:F${existing.row}`, [[
      phone, name || existing.name, address || existing.address,
      existing.firstOrder || t, t, existing.totalOrders,
    ]]);
  }
  return append("Customers!A2", [[phone, name || "", address || "", t, t, 0]]);
}
async function bumpCustomerOrders(phone) {
  const c = await getCustomer(phone);
  if (c) await update(`Customers!F${c.row}`, [[c.totalOrders + 1]]);
}
async function getAllCustomers() {
  const rows = await read("Customers!A2:F5000");
  return rows.filter((r) => r[0]).map((r) => ({ phone: r[0], name: r[1] || "" }));
}

// ---------- Orders (flexible line items) ----------
// Columns: Date | Time | Phone | Name | Items | Amount | Address | Status | PaymentStatus | OrderID
// Items serialized as "Name xQty @price | Name xQty @price"
function serializeItems(items) {
  return (items || []).map((i) => `${i.name} x${i.qty} @${i.price}`).join(" | ");
}
function parseItems(text) {
  return (text || "").split("|").map((p) => p.trim()).filter(Boolean).map((p) => {
    const m = p.match(/^(.*?)\s*x(\d+)\s*@([\d.]+)$/i);
    if (m) return { name: m[1].trim(), qty: Number(m[2]), price: Number(m[3]) };
    return { name: p, qty: 1, price: 0 };
  });
}
async function nextOrderId(dateStr) {
  const rows = await read("Orders!A2:J20000");
  const count = rows.filter((r) => r[0] === dateStr).length + 1;
  return `${dateStr.replace(/-/g, "")}-${String(count).padStart(3, "0")}`;
}
// o = { date, phone, name, items:[{name,qty,price}], amount, address }
async function addOrder(o) {
  const id = await nextOrderId(o.date);
  await append("Orders!A2", [[
    o.date, nowTime(), o.phone, o.name || "", serializeItems(o.items),
    o.amount, o.address || "", "confirmed", "pending", id,
  ]]);
  await bumpCustomerOrders(o.phone);
  return id;
}
async function getOrders(dateStr = todayStr()) {
  const rows = await read("Orders!A2:J20000");
  return rows
    .map((r, i) => ({
      row: i + 2, date: r[0], time: r[1], phone: r[2], name: r[3],
      items: parseItems(r[4]), itemsText: r[4] || "",
      amount: Number(r[5]) || 0, address: r[6] || "", status: r[7] || "", payment: r[8] || "", id: r[9] || "",
    }))
    .filter((o) => o.date === dateStr);
}
async function setOrderField(row, col, value) {
  return update(`Orders!${col}${row}`, [[value]]);
}
const COL = { status: "H", payment: "I" };

// ---------- DailyLog ----------
// Columns: Date | TotalOrders | TotalItems | Revenue | Collected | Pending
async function appendDailyLog(entry) {
  return append("DailyLog!A2", [[
    entry.date, entry.totalOrders, entry.totalItems, entry.revenue, entry.collected, entry.pending,
  ]]);
}

module.exports = {
  read, append, update, clear, todayStr, nowTime,
  getCatalog, upsertCatalogItems,
  getMenu, setMenuItems,
  getCustomer, upsertCustomer, getAllCustomers,
  addOrder, getOrders, setOrderField, COL,
  serializeItems, parseItems,
  appendDailyLog,
};
