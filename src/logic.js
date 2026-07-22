const cfg = require("./config");
const sheets = require("./sheets");
const { customerAnswer } = require("./brain");
const wa = require("./whatsapp");

// in-memory cart state: phone -> { cart:[{name,qty,price}], awaiting:'qty'|'address'|null, pendingItem:{name,price}|null }
const state = new Map();
let ordersPaused = false;

function setPaused(v) { ordersPaused = v; }
function isPaused() { return ordersPaused; }

function freshState() { return { cart: [], awaiting: null, pendingItem: null }; }

// ---------- rendering ----------
function groupByCategory(items) {
  const groups = new Map();
  for (const it of items) {
    const c = it.category || "Other";
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(it);
  }
  return groups;
}

/** Plain-text menu (used for the broadcast and as a text fallback). */
function renderMenu(items) {
  const b = cfg.biz;
  let out = `🍱 *${b.shopName}* — aaj ka menu\n`;
  for (const [cat, list] of groupByCategory(items)) {
    out += `\n*${cat}*\n` + list.map((it) => `• ${it.name} — ₹${it.price}`).join("\n") + "\n";
  }
  out += `\nOrder karne ke liye niche "Order" button dabayein 👇 ya item ka naam likhein.`;
  return out;
}

function cartTotal(cart) { return cart.reduce((n, i) => n + i.price * i.qty, 0); }
function cartSummary(cart) {
  return cart.map((i) => `${i.qty}× ${i.name} — ₹${i.price * i.qty}`).join("\n");
}

// ---------- interactive menu senders ----------
async function sendMenuInteractive(phone, items) {
  const groups = groupByCategory(items);
  // WhatsApp lists cap at 10 rows total. Flat list if small; category-first if big.
  if (items.length <= 10) {
    const sections = [...groups.entries()].map(([cat, list]) => ({
      title: cat,
      rows: list.map((it) => ({ id: `item:${it.name}`, title: it.name, description: `₹${it.price}` })),
    }));
    return wa.sendList(phone, {
      header: "Aaj ka menu 🍱", body: renderMenu(items),
      buttonText: "Order 🍱", sections,
    });
  }
  // big menu -> pick a category first
  const rows = [...groups.keys()].map((cat) => ({ id: `cat:${cat}`, title: cat, description: `${groups.get(cat).length} items` }));
  return wa.sendList(phone, {
    header: "Aaj ka menu 🍱", body: renderMenu(items),
    buttonText: "Category chunein", sections: [{ title: "Categories", rows }],
  });
}
async function sendCategoryItems(phone, items, category) {
  const list = items.filter((it) => (it.category || "Other") === category);
  if (!list.length) return wa.sendText(phone, `Us category mein abhi kuch nahi 🙏`);
  return wa.sendList(phone, {
    header: category, body: `${category} — kya lenge?`,
    buttonText: "Select", sections: [{ title: category, rows: list.map((it) => ({ id: `item:${it.name}`, title: it.name, description: `₹${it.price}` })) }],
  });
}
async function askQty(phone, item) {
  return wa.sendButtons(phone, {
    body: `${item.name} (₹${item.price}) — kitne chahiye?\n(ya number type karein)`,
    buttons: [{ id: "qty:1", title: "1" }, { id: "qty:2", title: "2" }, { id: "qty:3", title: "3" }],
  });
}
async function askAddMore(phone, s) {
  return wa.sendButtons(phone, {
    body: `✅ Cart:\n${cartSummary(s.cart)}\n— — —\nTotal: ₹${cartTotal(s.cart)}\n\nAur kuch?`,
    buttons: [{ id: "add_more", title: "➕ Add more" }, { id: "review", title: "🧾 Review" }],
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

/** Main entry: handle one incoming customer message / tap. */
async function handleMessage(phone, name, text, selectionId = null) {
  const b = cfg.biz;
  const s = state.get(phone) || freshState();

  if (ordersPaused) return wa.sendText(phone, `🙏 Aaj shop band hai. Kal milte hain!`);

  const menu = await sheets.getMenu();
  const menuAvailable = menu && menu.length;

  // ===== interactive taps =====
  if (selectionId) {
    if (selectionId.startsWith("cat:")) {
      if (!menuAvailable) return wa.sendText(phone, `Menu abhi update ho raha hai 🙏`);
      return sendCategoryItems(phone, menu, selectionId.slice(4));
    }
    if (selectionId.startsWith("item:")) {
      if (!menuAvailable) return wa.sendText(phone, `Menu abhi update ho raha hai 🙏`);
      const item = menu.find((it) => it.name === selectionId.slice(5));
      if (!item) return wa.sendText(phone, `Ye item aaj available nahi 🙏`);
      s.pendingItem = { name: item.name, price: item.price }; s.awaiting = "qty"; state.set(phone, s);
      return askQty(phone, item);
    }
    if (selectionId.startsWith("qty:")) {
      const qty = Number(selectionId.slice(4)) || 1;
      return addToCart(phone, name, s, qty);
    }
    if (selectionId === "add_more") return sendMenuInteractive(phone, menu || []);
    if (selectionId === "review") return reviewOrSubmit(phone, name, s);
    if (selectionId === "submit") return s.cart.length ? placeOrder(phone, name, s) : wa.sendText(phone, `Cart khali hai 🙂`);
    if (selectionId === "edit") { s.cart = []; s.awaiting = null; s.pendingItem = null; state.set(phone, s); return sendMenuInteractive(phone, menu || []); }
    if (selectionId === "cancel") { state.delete(phone); return wa.sendText(phone, `Order cancel ❌ Jab chahein order kar dena 🙏`); }
  }

  const lower = text.trim().toLowerCase();

  // ===== awaiting quantity (typed number) =====
  if (s.awaiting === "qty" && s.pendingItem) {
    const qty = parseInt(text.replace(/\D/g, ""), 10);
    if (qty > 0 && qty < 100) return addToCart(phone, name, s, qty);
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
    return sendMenuInteractive(phone, menu);
  }

  // ===== typed item name matches the menu =====
  if (menuAvailable) {
    const item = menu.find((it) => it.name.toLowerCase() === lower)
      || menu.find((it) => lower.length > 2 && it.name.toLowerCase().includes(lower));
    if (item) {
      s.pendingItem = { name: item.name, price: item.price }; s.awaiting = "qty"; state.set(phone, s);
      return askQty(phone, item);
    }
  }

  // ===== confirm/cancel words =====
  if (/^(haan|yes|ok|theek|thik|done|confirm)$/i.test(lower) && s.cart.length) return reviewOrSubmit(phone, name, s);
  if (/^(nahi|no|cancel)$/i.test(lower)) { state.delete(phone); return wa.sendText(phone, `Theek hai, cancel ❌ 🙏`); }

  // ===== anything else -> LLM answers the QUESTION (never orders) =====
  const answer = await customerAnswer(text, {
    shopName: b.shopName, menu: {}, snacks: (menu || []).map((m) => ({ item: m.name, price: m.price })),
    tiffinPrice: b.tiffinPrice, includedRotis: b.includedRotis, extraRotiPrice: b.extraRotiPrice,
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

async function addToCart(phone, name, s, qty) {
  if (!s.pendingItem) return wa.sendText(phone, `Pehle koi item chunein 🙏 "menu" likhein.`);
  const existing = s.cart.find((i) => i.name === s.pendingItem.name);
  if (existing) existing.qty += qty;
  else s.cart.push({ name: s.pendingItem.name, price: s.pendingItem.price, qty });
  s.pendingItem = null; s.awaiting = null; state.set(phone, s);
  return askAddMore(phone, s);
}

module.exports = { handleMessage, setPaused, isPaused, renderMenu, menuText: renderMenu };
