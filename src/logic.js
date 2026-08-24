const cfg = require("./config");
const sheets = require("./sheets");
const { customerAnswer } = require("./brain");
const wa = require("./whatsapp");
const menuParse = require("./menuParse");

// in-memory cart state: phone -> {
//   cart:[{name,qty,price}], lastLine:name|null,
//   awaiting:'tqty'|'address'|'confirm'|null,
//   picks:[{name,qty}], groupIdx:0   // tiffin being configured (fallback path)
// }
const state = new Map();
let ordersPaused = false;

function setPaused(v) { ordersPaused = v; }
function isPaused() { return ordersPaused; }

function freshState() { return { cart: [], awaiting: null, picks: [], groupIdx: 0, lastLine: null }; }

// ---------- rendering ----------
const optLabel = (o) => (o.qty ? `${o.name} x${o.qty}` : o.name);

/**
 * Human-readable menu from the parsed model.
 * `cta` appends the "tap the button" line — only true where a button/list is
 * actually attached, never on the owner's draft or the morning reminder.
 */
function renderMenuModel(m, { cta = false } = {}) {
  const b = cfg.biz;
  let out = `🍱 *${b.shopName}* — aaj ka menu\n`;

  if (menuParse.isTiffinMenu(m)) {
    const price = m.tiffinPrice != null ? m.tiffinPrice : b.tiffinPrice;
    out += `\n*TIFFIN — ₹${price}*\n`;
    for (const g of m.groups) out += `• ${g.name} (koi 1): ${g.options.map(optLabel).join(" / ")}\n`;
    if (m.included.length) out += `• Saath mein: ${m.included.map(optLabel).join(", ")}\n`;
  }

  if (m.extras.length) {
    out += `\n*EXTRA*\n` + m.extras.map((e) => `• ${e.name} — ₹${e.price}`).join("\n") + "\n";
  }

  if (cta) out += `\nOrder karne ke liye niche button dabayein 👇`;
  return out;
}

/** Menu rows straight from the sheet -> text. Keeps jobs.js unchanged. */
function renderMenu(rows) { return renderMenuModel(menuParse.fromSheetRows(rows || [])); }

function cartTotal(cart) { return cart.reduce((n, i) => n + i.price * i.qty, 0); }
function cartSummary(cart) {
  return cart.map((i) => `${i.qty}× ${i.name} — ₹${i.price * i.qty}`).join("\n");
}

// ---------- combos: every sabji×bread pairing as one tappable row ----------
// A WhatsApp list holds 10 rows in total, and combos multiply with each group
// (2×2 = 4 fits; 3×4 = 12 does not). Above the cap we fall back to asking one
// group at a time, so a big menu still works — just with more taps.
const MAX_ROWS = 10;

/** Cartesian product of the choice groups: [[optA, optB], ...]. */
function buildCombos(m) {
  if (!menuParse.isTiffinMenu(m)) return [];
  let combos = [[]];
  for (const g of m.groups) {
    const next = [];
    for (const picks of combos) for (const o of g.options) next.push([...picks, o]);
    combos = next;
  }
  return combos;
}

const comboTitle = (picks) => (picks.length ? menuParse.comboLabel(picks) : "Tiffin");
const comboCartName = (picks) => (picks.length ? `Tiffin (${menuParse.comboLabel(picks)})` : "Tiffin");

/** Can the whole menu be shown as one tap-to-order list? */
function comboListFits(m) {
  const combos = buildCombos(m);
  return combos.length > 0 && combos.length + m.extras.length <= MAX_ROWS;
}

// ---------- interactive senders ----------
async function sendMenuInteractive(phone, m) {
  const isTiffin = menuParse.isTiffinMenu(m);

  // Flat priced list only (no tiffin) -> behave like a plain item list.
  if (!isTiffin) return sendExtrasList(phone, m, renderMenuModel(m, { cta: true }));

  // Preferred path: one list, one tap picks the whole tiffin.
  if (comboListFits(m)) return sendComboList(phone, m);

  // Too many combinations for one list -> ask group by group.
  const buttons = [{ id: "t:start", title: "🍱 Tiffin order" }];
  if (m.extras.length) buttons.push({ id: "x:list", title: "➕ Extra items" });
  return wa.sendButtons(phone, { body: renderMenuModel(m, { cta: true }), buttons });
}

/** The whole day's menu as a single tappable list. */
async function sendComboList(phone, m) {
  const price = m.tiffinPrice != null ? m.tiffinPrice : cfg.biz.tiffinPrice;
  const combos = buildCombos(m);
  const incl = m.included.length ? `\nSaath mein: ${m.included.map(optLabel).join(", ")}` : "";

  const sections = [{
    title: "Tiffin 🍱",
    rows: combos.map((picks, i) => ({ id: `c:${i}`, title: comboTitle(picks), description: `₹${price}` })),
  }];
  if (m.extras.length) {
    sections.push({
      title: "Extra ➕",
      rows: m.extras.map((e, i) => ({ id: `x:${i}`, title: e.name, description: `₹${e.price}` })),
    });
  }

  return wa.sendList(phone, {
    header: "Aaj ka menu 🍱",
    body: `🍱 *${cfg.biz.shopName}*\nTiffin ₹${price}${incl}\n\nJo chahiye woh select karein 👇 Ek hi tap mein order.`,
    buttonText: "Select 🍱",
    sections,
  });
}

async function sendExtrasList(phone, m, body) {
  if (!m.extras.length) return wa.sendText(phone, `Aaj koi extra item nahi hai 🙏`);
  return wa.sendList(phone, {
    header: "Extra items ➕",
    body: body || `Extra mein kya lenge?`,
    buttonText: "Select",
    sections: [{
      title: "Extra",
      rows: m.extras.map((e, i) => ({ id: `x:${i}`, title: e.name, description: `₹${e.price}` })),
    }],
  });
}

/** Ask the customer to pick one option from the current group. */
async function askGroup(phone, s, m) {
  const g = m.groups[s.groupIdx];
  if (!g) return askTiffinQty(phone, s, m);

  const gi = s.groupIdx;
  const chosen = s.picks.map(optLabel).join(" + ");
  const body = `${chosen ? `✅ ${chosen}\n\n` : ""}*${g.name}* — koi 1 chunein 👇`;

  // Up to 3 options fit as buttons; more need a list.
  if (g.options.length <= 3) {
    return wa.sendButtons(phone, {
      body,
      buttons: g.options.map((o, oi) => ({ id: `t:p:${gi}:${oi}`, title: optLabel(o) })),
    });
  }
  return wa.sendList(phone, {
    header: g.name, body, buttonText: "Select",
    sections: [{ title: g.name, rows: g.options.map((o, oi) => ({ id: `t:p:${gi}:${oi}`, title: optLabel(o) })) }],
  });
}

async function askTiffinQty(phone, s, m) {
  const price = m.tiffinPrice != null ? m.tiffinPrice : cfg.biz.tiffinPrice;
  s.awaiting = "tqty"; state.set(phone, s);
  const incl = m.included.length ? `\nSaath mein: ${m.included.map(optLabel).join(", ")}` : "";
  return wa.sendButtons(phone, {
    body: `🍱 *${menuParse.comboLabel(s.picks)}*${incl}\n₹${price} per tiffin\n\nKitne tiffin chahiye?\n(ya number type karein)`,
    buttons: [{ id: "t:qty:1", title: "1" }, { id: "t:qty:2", title: "2" }, { id: "t:qty:3", title: "3" }],
  });
}

async function addTiffinToCart(phone, s, m, qty) {
  const price = m.tiffinPrice != null ? m.tiffinPrice : cfg.biz.tiffinPrice;
  addLine(s, comboCartName(s.picks), price, qty);
  s.picks = []; s.groupIdx = 0; s.awaiting = null;
  state.set(phone, s);
  return askAddMore(phone, s, m);
}

/** Add one line to the cart (or bump an existing one) and remember it as latest. */
function addLine(s, name, price, qty = 1) {
  const existing = s.cart.find((i) => i.name === name);
  if (existing) existing.qty += qty;
  else s.cart.push({ name, price, qty });
  s.lastLine = name;
  return s;
}

async function askAddMore(phone, s, m) {
  const buttons = [];
  if (menuParse.isTiffinMenu(m)) buttons.push({ id: "t:start", title: "🍱 Aur tiffin" });
  if (m.extras.length) buttons.push({ id: "x:list", title: "➕ Extra" });
  buttons.push({ id: "review", title: "🧾 Review" });
  return wa.sendButtons(phone, {
    body: `✅ Cart:\n${cartSummary(s.cart)}\n— — —\nTotal: ₹${cartTotal(s.cart)}\n\nAur kuch?`,
    buttons,
  });
}

async function forwardToOwner(phone, name, text) {
  await wa.sendText(cfg.biz.ownerPhone, `👤 ${name || phone}: "${text}"\n(customer query — reply karein)`);
}

/**
 * The single confirm card — cart, total and the delivery address in one message.
 * The saved address is shown (never applied silently) and changed from the same
 * card, so a returning customer's whole order is two taps: pick, confirm.
 */
async function reviewOrSubmit(phone, name, s) {
  if (!s.cart.length) return wa.sendText(phone, `Cart khali hai 🙂 "menu" likh kar order shuru karein.`);
  const customer = await sheets.getCustomer(phone);
  if (!customer || !customer.address) {
    s.awaiting = "address"; state.set(phone, s);
    return wa.sendText(phone, `${cartSummary(s.cart)}\nTotal: ₹${cartTotal(s.cart)} 👍\n\nAapka delivery address bhejein (ghar/flat no, building, area) 🏠`);
  }
  s.awaiting = "confirm"; state.set(phone, s);
  return wa.sendButtons(phone, {
    body: `🧾 *Order*\n${cartSummary(s.cart)}\n— — —\nTotal: ₹${cartTotal(s.cart)}\n📍 ${customer.address}\n\n` +
      `(quantity badalni ho toh number bhejein · cancel karne ke liye "cancel")`,
    buttons: [
      { id: "submit", title: "✅ Confirm order" },
      { id: "add_more", title: "➕ Add more" },
      { id: "addr:new", title: "✏️ Address" },
    ],
  });
}

async function placeOrder(phone, name, s) {
  const customer = await sheets.getCustomer(phone);
  const amount = cartTotal(s.cart);
  const id = await sheets.addOrder({
    date: sheets.todayStr(), phone, name: customer?.name || name,
    items: s.cart, amount, address: customer?.address || "",
  });
  state.delete(phone);
  return wa.sendText(phone, `Order confirm ✅ (#${id})\n${cartSummary(s.cart)}\nTotal: ₹${amount}\nJald deliver ho jayega. Dhanyawad 🙏`);
}

// ---------- interactive taps ----------
/** Returns a promise when the tap was handled, or null to fall through to text. */
function handleTap(phone, name, s, m, selectionId, menuAvailable) {
  const notReady = () => wa.sendText(phone, `Menu abhi update ho raha hai 🙏`);

  if (selectionId === "t:start") {
    if (!menuAvailable) return notReady();
    s.picks = []; s.groupIdx = 0; s.awaiting = null; state.set(phone, s);
    return askGroup(phone, s, m);
  }

  if (selectionId.startsWith("t:p:")) {
    if (!menuAvailable) return notReady();
    const [, , gi, oi] = selectionId.split(":");
    const group = m.groups[Number(gi)];
    const option = group?.options[Number(oi)];
    if (!option) return wa.sendText(phone, `Ye option aaj available nahi 🙏`);
    // Re-taps of an earlier group replace that pick instead of appending.
    s.picks = s.picks.slice(0, Number(gi));
    s.picks.push(option);
    s.groupIdx = Number(gi) + 1;
    state.set(phone, s);
    return askGroup(phone, s, m);
  }

  if (selectionId.startsWith("t:qty:")) {
    if (!menuAvailable) return notReady();
    if (!s.picks.length) return wa.sendText(phone, `Pehle tiffin ke options chunein 🙏 "menu" likhein.`);
    return addTiffinToCart(phone, s, m, Number(selectionId.slice(6)) || 1);
  }

  if (selectionId === "x:list") {
    if (!menuAvailable) return notReady();
    return sendExtrasList(phone, m);
  }

  if (/^x:\d+$/.test(selectionId)) {
    if (!menuAvailable) return notReady();
    const e = m.extras[Number(selectionId.slice(2))];
    if (!e) return wa.sendText(phone, `Ye item aaj available nahi 🙏`);
    addLine(s, e.name, e.price);
    s.awaiting = null; state.set(phone, s);
    return reviewOrSubmit(phone, name, s);
  }

  // One tap = the whole tiffin, then straight to the confirm card.
  if (/^c:\d+$/.test(selectionId)) {
    if (!menuAvailable) return notReady();
    const picks = buildCombos(m)[Number(selectionId.slice(2))];
    if (!picks) return wa.sendText(phone, `Ye option aaj available nahi 🙏`);
    const price = m.tiffinPrice != null ? m.tiffinPrice : cfg.biz.tiffinPrice;
    addLine(s, comboCartName(picks), price);
    s.picks = []; s.groupIdx = 0; s.awaiting = null; state.set(phone, s);
    return reviewOrSubmit(phone, name, s);
  }

  if (selectionId === "addr:new") {
    s.awaiting = "address"; state.set(phone, s);
    return wa.sendText(phone, `Naya delivery address bhejein 🏠\n(ghar/flat no, building, area)`);
  }

  if (selectionId === "add_more") return sendMenuInteractive(phone, m);
  if (selectionId === "review") return reviewOrSubmit(phone, name, s);
  if (selectionId === "submit") return s.cart.length ? placeOrder(phone, name, s) : wa.sendText(phone, `Cart khali hai 🙂`);
  if (selectionId === "edit") {
    s.cart = []; s.awaiting = null; s.picks = []; s.groupIdx = 0; s.lastLine = null;
    state.set(phone, s);
    return sendMenuInteractive(phone, m);
  }
  if (selectionId === "cancel") { state.delete(phone); return wa.sendText(phone, `Order cancel ❌ Jab chahein order kar dena 🙏`); }
  return null;
}

/** Send today's menu to one phone as the interactive, tappable message. */
async function sendMenuTo(phone, rows) {
  return sendMenuInteractive(phone, menuParse.fromSheetRows(rows || []));
}

/** Main entry: handle one incoming customer message / tap. */
async function handleMessage(phone, name, text, selectionId = null) {
  const b = cfg.biz;
  const s = state.get(phone) || freshState();

  if (ordersPaused) return wa.sendText(phone, `🙏 Aaj shop band hai. Kal milte hain!`);

  const rows = await sheets.getMenu();
  const menuAvailable = !!(rows && rows.length);
  const m = menuParse.fromSheetRows(rows || []);

  // ===== interactive taps =====
  if (selectionId) {
    const handled = handleTap(phone, name, s, m, selectionId, menuAvailable);
    if (handled) return handled;
  }

  const lower = text.trim().toLowerCase();

  // ===== awaiting a typed quantity =====
  if (s.awaiting === "tqty" && s.picks.length) {
    const qty = parseInt(text.replace(/\D/g, ""), 10);
    if (qty > 0 && qty < 100) return addTiffinToCart(phone, s, m, qty);
  }
  // On the confirm card a bare number changes the quantity of the last line.
  if (s.awaiting === "confirm" && s.cart.length && /^\d{1,2}$/.test(lower)) {
    const qty = parseInt(lower, 10);
    if (qty > 0) {
      const line = s.cart.find((i) => i.name === s.lastLine) || s.cart[s.cart.length - 1];
      line.qty = qty;
      state.set(phone, s);
      return reviewOrSubmit(phone, name, s);
    }
  }

  // ===== awaiting address =====
  if (s.awaiting === "address" && text.trim().length > 6) {
    await sheets.upsertCustomer({ phone, name, address: text.trim() });
    s.awaiting = null; state.set(phone, s);
    await wa.sendText(phone, `Address save ho gaya ✅`);
    return reviewOrSubmit(phone, name, s);
  }

  // ===== greeting / menu request =====
  if (/^(hi|hii|hello|hey|namaste|namaskar|menu|order|start|good\s*(morning|evening|afternoon))/i.test(lower) || lower === "") {
    if (!menuAvailable) return wa.sendText(phone, `Namaste ${name || ""}! 🙏 Aaj ka menu abhi update ho raha hai, thodi der mein bhejte hain.`);
    await wa.sendText(phone, `Namaste ${name || ""}! 🙏`);
    return sendMenuInteractive(phone, m);
  }

  // ===== typed "tiffin" starts the tiffin flow =====
  if (menuAvailable && menuParse.isTiffinMenu(m) && /^(tiffin|thali|dabba)\b/i.test(lower)) {
    s.picks = []; s.groupIdx = 0; state.set(phone, s);
    return askGroup(phone, s, m);
  }

  // ===== typed extra name =====
  if (menuAvailable && m.extras.length) {
    const e = m.extras.find((it) => it.name.toLowerCase() === lower)
      || m.extras.find((it) => lower.length > 2 && it.name.toLowerCase().includes(lower));
    if (e) {
      addLine(s, e.name, e.price);
      s.awaiting = null; state.set(phone, s);
      return reviewOrSubmit(phone, name, s);
    }
  }

  // ===== confirm/cancel words =====
  if (/^(haan|yes|ok|theek|thik|done|confirm)$/i.test(lower) && s.cart.length) return reviewOrSubmit(phone, name, s);
  if (/^(nahi|no|cancel)$/i.test(lower)) { state.delete(phone); return wa.sendText(phone, `Theek hai, cancel ❌ 🙏`); }

  // ===== anything else -> LLM answers the QUESTION (never orders) =====
  const answer = await customerAnswer(text, {
    shopName: b.shopName, menu: {}, snacks: m.extras.map((e) => ({ item: e.name, price: e.price })),
    tiffinPrice: m.tiffinPrice != null ? m.tiffinPrice : b.tiffinPrice,
    includedRotis: b.includedRotis, extraRotiPrice: b.extraRotiPrice,
    orderCutoff: b.orderCutoff, deliveryNote: b.radiusNote,
  });
  if (answer && answer !== "FORWARD") {
    await wa.sendText(phone, answer);
    if (menuAvailable) return wa.sendText(phone, `Order karne ke liye "menu" likhein 🍱`);
    return;
  }
  await forwardToOwner(phone, name, text);
  return wa.sendText(phone, `Ek minute 🙏 bhaiya ko bata raha hun, woh reply karenge.`);
}

module.exports = {
  handleMessage, setPaused, isPaused,
  renderMenu, menuText: renderMenu, renderMenuModel, sendMenuTo,
};
