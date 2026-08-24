const cfg = require("./config");
const sheets = require("./sheets");
const { customerAnswer } = require("./brain");
const wa = require("./whatsapp");
const menuParse = require("./menuParse");

// in-memory cart state: phone -> {
//   cart:[{name,qty,price}], awaiting:'qty'|'tqty'|'address'|null,
//   pendingItem:{name,price}|null,   // an EXTRA being quantified
//   picks:[{name,qty}], groupIdx:0   // tiffin being configured
// }
const state = new Map();
let ordersPaused = false;

function setPaused(v) { ordersPaused = v; }
function isPaused() { return ordersPaused; }

function freshState() { return { cart: [], awaiting: null, pendingItem: null, picks: [], groupIdx: 0, addressOk: false }; }

// ---------- rendering ----------
const optLabel = (o) => (o.qty ? `${o.name} x${o.qty}` : o.name);

/** Human-readable menu from the parsed model. Used for the broadcast and the owner draft. */
function renderMenuModel(m) {
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

  out += `\nOrder karne ke liye niche button dabayein 👇`;
  return out;
}

/** Menu rows straight from the sheet -> text. Keeps jobs.js unchanged. */
function renderMenu(rows) { return renderMenuModel(menuParse.fromSheetRows(rows || [])); }

function cartTotal(cart) { return cart.reduce((n, i) => n + i.price * i.qty, 0); }
function cartSummary(cart) {
  return cart.map((i) => `${i.qty}× ${i.name} — ₹${i.price * i.qty}`).join("\n");
}

// ---------- interactive senders ----------
async function sendMenuInteractive(phone, m) {
  const isTiffin = menuParse.isTiffinMenu(m);

  // Flat priced list only (no tiffin) -> behave like a plain item list.
  if (!isTiffin) return sendExtrasList(phone, m, renderMenuModel(m));

  const buttons = [{ id: "t:start", title: "🍱 Tiffin order" }];
  if (m.extras.length) buttons.push({ id: "x:list", title: "➕ Extra items" });
  return wa.sendButtons(phone, { body: renderMenuModel(m), buttons });
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
  const name = `Tiffin (${menuParse.comboLabel(s.picks)})`;
  const existing = s.cart.find((i) => i.name === name);
  if (existing) existing.qty += qty;
  else s.cart.push({ name, price, qty });
  s.picks = []; s.groupIdx = 0; s.awaiting = null;
  state.set(phone, s);
  return askAddMore(phone, s, m);
}

async function askQty(phone, item) {
  return wa.sendButtons(phone, {
    body: `${item.name} (₹${item.price}) — kitne chahiye?\n(ya number type karein)`,
    buttons: [{ id: "qty:1", title: "1" }, { id: "qty:2", title: "2" }, { id: "qty:3", title: "3" }],
  });
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

async function reviewOrSubmit(phone, name, s) {
  if (!s.cart.length) return wa.sendText(phone, `Cart khali hai 🙂 "menu" likh kar order shuru karein.`);
  const customer = await sheets.getCustomer(phone);
  if (!customer || !customer.address) {
    s.awaiting = "address"; state.set(phone, s);
    return wa.sendText(phone, `${cartSummary(s.cart)}\nTotal: ₹${cartTotal(s.cart)} 👍\n\nAapka delivery address bhejein (ghar/flat no, building, area) 🏠`);
  }
  // Returning customer: never reuse the saved address silently — show it and ask.
  if (!s.addressOk) {
    s.awaiting = null; state.set(phone, s);
    return wa.sendButtons(phone, {
      body: `${cartSummary(s.cart)}\nTotal: ₹${cartTotal(s.cart)} 👍\n\n🏠 Pichli baar wala address:\n*${customer.address}*\n\nYahi bhejein ya naya address?`,
      buttons: [
        { id: "addr:same", title: "✅ Yahi address" },
        { id: "addr:new", title: "✏️ Naya address" },
      ],
    });
  }
  s.awaiting = null; state.set(phone, s);
  return wa.sendButtons(phone, {
    body: `🧾 *Order review*\n${cartSummary(s.cart)}\n— — —\nTotal: ₹${cartTotal(s.cart)}\nDeliver: ${customer.address}`,
    buttons: [{ id: "submit", title: "✅ Submit" }, { id: "edit", title: "✏️ Edit" }, { id: "cancel", title: "❌ Cancel" }],
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

async function addToCart(phone, name, s, qty) {
  if (!s.pendingItem) return wa.sendText(phone, `Pehle koi item chunein 🙏 "menu" likhein.`);
  const existing = s.cart.find((i) => i.name === s.pendingItem.name);
  if (existing) existing.qty += qty;
  else s.cart.push({ name: s.pendingItem.name, price: s.pendingItem.price, qty });
  s.pendingItem = null; s.awaiting = null; state.set(phone, s);
  const m = menuParse.fromSheetRows(await sheets.getMenu());
  return askAddMore(phone, s, m);
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
    s.pendingItem = { name: e.name, price: e.price }; s.awaiting = "qty"; state.set(phone, s);
    return askQty(phone, e);
  }

  if (selectionId === "addr:same") { s.addressOk = true; state.set(phone, s); return reviewOrSubmit(phone, name, s); }
  if (selectionId === "addr:new") {
    s.awaiting = "address"; s.addressOk = false; state.set(phone, s);
    return wa.sendText(phone, `Naya delivery address bhejein 🏠\n(ghar/flat no, building, area)`);
  }

  if (selectionId.startsWith("qty:")) return addToCart(phone, name, s, Number(selectionId.slice(4)) || 1);
  if (selectionId === "add_more") return sendMenuInteractive(phone, m);
  if (selectionId === "review") return reviewOrSubmit(phone, name, s);
  if (selectionId === "submit") return s.cart.length ? placeOrder(phone, name, s) : wa.sendText(phone, `Cart khali hai 🙂`);
  if (selectionId === "edit") {
    s.cart = []; s.awaiting = null; s.pendingItem = null; s.picks = []; s.groupIdx = 0;
    state.set(phone, s);
    return sendMenuInteractive(phone, m);
  }
  if (selectionId === "cancel") { state.delete(phone); return wa.sendText(phone, `Order cancel ❌ Jab chahein order kar dena 🙏`); }
  return null;
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
  if (s.awaiting === "qty" && s.pendingItem) {
    const qty = parseInt(text.replace(/\D/g, ""), 10);
    if (qty > 0 && qty < 100) return addToCart(phone, name, s, qty);
  }

  // ===== awaiting address =====
  if (s.awaiting === "address" && text.trim().length > 6) {
    await sheets.upsertCustomer({ phone, name, address: text.trim() });
    s.awaiting = null; s.addressOk = true; state.set(phone, s);
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
      s.pendingItem = { name: e.name, price: e.price }; s.awaiting = "qty"; state.set(phone, s);
      return askQty(phone, e);
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
  renderMenu, menuText: renderMenu, renderMenuModel,
};
