const cfg = require("./config");
const sheets = require("./sheets");
const { customerAnswer } = require("./brain");
const wa = require("./whatsapp");
const menuParse = require("./menuParse");
const flowOrder = require("./flowOrder");

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
const optLabel = menuParse.optDisplay;

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
async function sendMenuInteractive(phone, m, s = null) {
  const isTiffin = menuParse.isTiffinMenu(m);

  // Flat priced list only (no tiffin) -> behave like a plain item list.
  if (!isTiffin) return sendExtrasList(phone, m, renderMenuModel(m, { cta: true }));

  // Preferred path: one list, one tap picks the whole tiffin.
  if (comboListFits(m)) return sendComboList(phone, m, s);

  // Too many combinations for one list -> ask group by group.
  const buttons = [{ id: "t:start", title: "🍱 Tiffin order" }];
  if (m.extras.length) buttons.push({ id: "x:list", title: "➕ Extra items" });
  return wa.sendButtons(phone, { body: renderMenuModel(m, { cta: true }), buttons });
}

/**
 * The whole day's menu as one tappable list, laid out like a menu board.
 *
 * Row titles are capped at 24 characters by WhatsApp, so "Paneer Bhurji Sabji +
 * Roti x5" would arrive truncated to "Paneer Bhurji Sabji + Ro" — and its
 * sibling row to "...+ Th", leaving two rows a customer can't tell apart.
 * Instead the FIRST choice group becomes the section heading and the remaining
 * groups become short rows under it:
 *
 *   Paneer Bhurji Sabji          <- section
 *     + 5 Roti          ₹80      <- row
 *     + 4 Thepla        ₹80
 *   Sev Tameta
 *     + 5 Roti          ₹80
 *     ...
 */
async function sendComboList(phone, m, s = null) {
  const price = m.tiffinPrice != null ? m.tiffinPrice : cfg.biz.tiffinPrice;
  const combos = buildCombos(m);
  const incl = m.included.length ? `\n🍚 Har tiffin ke saath: ${m.included.map(menuParse.optDisplay).join(", ")}` : "";
  const sections = [];

  // What's already in the cart, so rows can carry a ✅ instead of looking unpicked.
  const inCart = new Map((s?.cart || []).map((i) => [i.name, i.qty]));

  /** Indented, tick-marked row. NBSP survives any client that trims spaces. */
  const row = (id, cartName, label, rupees) => {
    const qty = inCart.get(cartName);
    return {
      id,
      title: qty ? `✅ ${label}` : `  • ${label}`,
      description: qty ? `    ₹${rupees} · ${qty}× order mein` : `    ₹${rupees}`,
    };
  };

  if (m.groups.length >= 2) {
    // Section per first-group option; rows are the rest of the combination.
    for (const headOpt of m.groups[0].options) {
      const rows = combos
        .map((picks, ci) => ({ picks, ci }))
        .filter(({ picks }) => picks[0] === headOpt)
        .map(({ picks, ci }) =>
          row(`c:${ci}`, comboCartName(picks), picks.slice(1).map(menuParse.optDisplay).join(" + "), price));
      if (rows.length) sections.push({ title: `🍛 ${menuParse.optDisplay(headOpt).toUpperCase()}`, rows });
    }
  } else {
    sections.push({
      title: m.groups.length ? `🍛 ${m.groups[0].name.toUpperCase()}` : "🍱 TIFFIN",
      rows: combos.map((picks, i) => row(`c:${i}`, comboCartName(picks), comboTitle(picks), price)),
    });
  }

  // Offered ONLY while the cart is empty. A WhatsApp list is a single radio
  // group, so tapping any row here - a navigation row included - moves the
  // selection off the tiffin row the customer just picked, which reads as
  // "my tiffin was removed". Once something is in the cart, extras are
  // reached from the confirm card instead, where buttons hold no such state.
  // No extras row here on purpose. This list has ONE job - pick the tiffin -
  // and a list is a single radio group, so any other row would move the
  // selection off the tiffin. Extras follow automatically as step 2.
  const extrasNote = m.extras.length
    ? `\n\n➕ Extra step 2 mein: ${m.extras.map((e) => `${e.name} ₹${e.price}`).join(", ")}`
    : "";

  const cart = s && s.cart.length
    ? `\n\n🧾 Abhi tak: ${s.cart.map((i) => `${i.qty}× ${i.name}`).join(", ")}`
    : "";

  return wa.sendList(phone, {
    header: "Aaj ka menu 🍱",
    body: `🍱 *${cfg.biz.shopName}*\n\n*Step 1 — Tiffin chunein (₹${price})*${incl}${extrasNote}${cart}`,
    buttonText: "Tiffin chunein 🍱",
    sections,
  });
}

/**
 * Extras in their own message, so adding one never touches the tiffin list.
 * Each tap adds that extra and comes back to the confirm card; tapping "➕ Extra"
 * again reopens this with the already-added ones ticked, which is as close to
 * checkbox behaviour as a WhatsApp list allows.
 */
/**
 * Extras as genuine toggle BUTTONS — the closest WhatsApp gets to checkboxes
 * outside Flows.
 *
 * A list is a radio group: it shows one selection and moving it looks like the
 * previous pick was cancelled. Reply buttons hold no selection state at all, so
 * each tap can simply flip an item on or off and the message re-renders with
 * ☑ / ☐ in the button labels themselves. Nothing ever appears to deselect.
 *
 * WhatsApp caps a message at 3 buttons, and one is needed for "done", so this
 * only works with 2 extras or fewer; beyond that we fall back to the list.
 */
const TOGGLE_BUTTON_MAX = 2;

function extrasFitButtons(m) { return m.extras.length > 0 && m.extras.length <= TOGGLE_BUTTON_MAX; }

async function sendExtrasToggle(phone, m, s) {
  const inCart = new Set((s?.cart || []).map((i) => i.name));
  const tiffins = (s?.cart || []).filter((i) => i.name.startsWith("Tiffin"));

  const lines = m.extras.map((e) => `${inCart.has(e.name) ? "☑" : "☐"} ${e.name} — ₹${e.price}`).join("\n");
  const head = tiffins.length
    ? `☑ ${tiffins.map((i) => `${i.qty}× ${i.name}`).join("\n☑ ")}\n\n`
    : "";

  const picked = m.extras.some((e) => inCart.has(e.name));
  return wa.sendButtons(phone, {
    body: `${head}*Step 2 — Extra chahiye?* (optional)\n${lines}\n\n` +
      `— — —\n*Total: ₹${cartTotal(s?.cart || [])}*`,
    buttons: [
      ...m.extras.map((e, i) => ({
        id: `x:${i}`,
        title: `${inCart.has(e.name) ? "☑" : "☐"} ${e.name}`,
      })),
      { id: "review", title: picked ? "✅ Aage badhein" : "⏭️ Nahi chahiye" },
    ],
  });
}

/** Toggle buttons when they fit, otherwise the tick-marked list. */
async function sendExtras(phone, m, s) {
  return extrasFitButtons(m) ? sendExtrasToggle(phone, m, s) : sendExtrasList(phone, m, null, s);
}

async function sendExtrasList(phone, m, body, s = null) {
  if (!m.extras.length) return wa.sendText(phone, `Aaj koi extra item nahi hai 🙏`);
  const inCart = new Map((s?.cart || []).map((i) => [i.name, i.qty]));
  const tiffin = (s?.cart || []).filter((i) => i.name.startsWith("Tiffin"));

  return wa.sendList(phone, {
    header: "Extra items ➕",
    body: body || (tiffin.length
      ? `✅ Aapka tiffin order mein hai:\n${tiffin.map((i) => `• ${i.qty}× ${i.name}`).join("\n")}\n\nExtra add karein — tiffin waise ka waisa rahega 👇`
      : `Extra mein kya lenge? 👇
(☑ = order mein hai · dobara tap karne se hat jayega)`),
    buttonText: "Extra chunein ➕",
    sections: [{
      title: "➕ EXTRA",
      rows: m.extras.map((e, i) => {
        const line = (s?.cart || []).find((c) => c.name === e.name);
        return {
          id: `x:${i}`,
          title: line ? `☑ ${e.name}` : `☐ ${e.name}`,
          description: line
            ? `    ₹${e.price} · tap karke hatayein`
            : `    ₹${e.price} · tap karke add karein`,
        };
      }),
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

async function addTiffinToCart(phone, name, s, m, qty) {
  const price = m.tiffinPrice != null ? m.tiffinPrice : cfg.biz.tiffinPrice;
  addLine(s, comboCartName(s.picks), price, qty);
  s.picks = []; s.groupIdx = 0; s.awaiting = null;
  state.set(phone, s);
  // Same three steps as the combo path: tiffin -> extras (optional) -> review.
  return m.extras.length ? sendExtras(phone, m, s) : reviewOrSubmit(phone, name, s);
}

/** Add one line to the cart (or bump an existing one) and remember it as latest. */
function addLine(s, name, price, qty = 1) {
  const existing = s.cart.find((i) => i.name === name);
  if (existing) existing.qty += qty;
  else s.cart.push({ name, price, qty });
  s.lastLine = name;
  return s;
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
  const m = menuParse.fromSheetRows(await sheets.getMenu());
  return wa.sendButtons(phone, {
    body: renderOrderPanel(s, m, customer.address),
    buttons: [
      { id: "submit", title: "✅ Confirm order" },
      { id: "addr:new", title: "✏️ Address badlein" },
      { id: "add_more", title: "➕ Aur add karein" },
    ],
  });
}

/**
 * The order panel: everything chosen, everything available, in ONE message.
 *
 * WhatsApp has no checkbox widget outside Flows — a list shows exactly one
 * selection and forgets it. Message text, though, is entirely ours, so every
 * extra is listed with ☑ or ☐ and the whole state stays visible after each tap.
 * Combined with tapping an extra toggling it on and off, this is checkbox
 * behaviour built out of the parts WhatsApp does give us.
 */
function renderOrderPanel(s, m, address) {
  const tiffins = s.cart.filter((i) => i.name.startsWith("Tiffin"));
  const inCart = new Set(s.cart.map((i) => i.name));

  let out = `🧾 *Aapka order*\n\n`;

  // Only mention a tiffin on a day that actually has one.
  if (menuParse.isTiffinMenu(m)) {
    out += tiffins.length
      ? tiffins.map((i) => `☑ ${i.qty}× ${i.name} — ₹${i.price * i.qty}`).join("\n") + "\n"
      : `☐ Tiffin abhi nahi chuna\n`;
  }

  if (m.extras.length) {
    out += `${menuParse.isTiffinMenu(m) ? "\n*Extra*" : "*Items*"} (jitne chahein):\n`;
    out += m.extras.map((e) => {
      const line = s.cart.find((i) => i.name === e.name);
      const tick = inCart.has(e.name) ? "☑" : "☐";
      const qty = line && line.qty > 1 ? ` — ${line.qty}× = ₹${line.price * line.qty}` : "";
      return `${tick} ${e.name} — ₹${e.price}${qty}`;
    }).join("\n") + "\n";
  }

  // Anything in the cart that today's menu no longer lists (menu changed
  // mid-order) still has to be shown, or the total wouldn't add up.
  const known = new Set([...tiffins.map((i) => i.name), ...m.extras.map((e) => e.name)]);
  const orphans = s.cart.filter((i) => !known.has(i.name));
  if (orphans.length) out += orphans.map((i) => `☑ ${i.qty}× ${i.name} — ₹${i.price * i.qty}`).join("\n") + "\n";

  out += `\n— — —\n*Total: ₹${cartTotal(s.cart)}*\n\n`;
  out += `📍 *Delivery address:*\n${address}\n\n`;
  out += `(quantity ke liye number bhejein · "cancel" se rad karein)`;
  return out;
}

async function placeOrder(phone, name, s) {
  const customer = await sheets.getCustomer(phone);
  const address = (customer?.address || "").trim();
  // Never bank an order we can't deliver — that lands as "address?" on the
  // owner's delivery list with no way to recover it.
  if (!address) {
    s.awaiting = "address"; state.set(phone, s);
    return wa.sendText(phone, `Order lagane se pehle delivery address chahiye 🏠\n(ghar/flat no, building, area)`);
  }
  const amount = cartTotal(s.cart);
  const id = await sheets.addOrder({
    date: sheets.todayStr(), phone, name: customer?.name || name,
    items: s.cart, amount, address,
  });
  state.delete(phone);
  return wa.sendText(phone,
    `Order confirm ✅ (#${id})\n\n${cartSummary(s.cart)}\n— — —\nTotal: ₹${amount}\n\n` +
    `📍 *Delivery address:*\n${address}\n\n` +
    `Address galat ho toh abhi bata dein 🙏\nJald deliver ho jayega. Dhanyawad 🙂`);
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
    return addTiffinToCart(phone, name, s, m, Number(selectionId.slice(6)) || 1);
  }

  if (selectionId === "x:list") {
    if (!menuAvailable) return notReady();
    return sendExtras(phone, m, s);
  }

  if (/^x:\d+$/.test(selectionId)) {
    if (!menuAvailable) return notReady();
    const e = m.extras[Number(selectionId.slice(2))];
    if (!e) return wa.sendText(phone, `Ye item aaj available nahi 🙏`);
    // Toggle, not add: tapping a ticked extra unticks it. That is what makes a
    // radio-only list behave like a checkbox from the customer's side.
    const at = s.cart.findIndex((i) => i.name === e.name);
    if (at >= 0) {
      s.cart.splice(at, 1);
      if (s.lastLine === e.name) s.lastLine = null;
    } else {
      addLine(s, e.name, e.price);
    }
    s.awaiting = null; state.set(phone, s);
    // Removing the last line empties the cart — go back to the menu, not a panel.
    if (!s.cart.length && !extrasFitButtons(m)) return sendMenuInteractive(phone, m, s);
    // With toggle buttons, stay on that message so ticking feels like a checkbox.
    if (extrasFitButtons(m)) return sendExtrasToggle(phone, m, s);
    return reviewOrSubmit(phone, name, s);
  }

  // Step 1 done: one tap picked the whole tiffin. Step 2 is extras (optional),
  // and if there are none today we go straight to the review.
  if (/^c:\d+$/.test(selectionId)) {
    if (!menuAvailable) return notReady();
    const picks = buildCombos(m)[Number(selectionId.slice(2))];
    if (!picks) return wa.sendText(phone, `Ye option aaj available nahi 🙏`);
    const price = m.tiffinPrice != null ? m.tiffinPrice : cfg.biz.tiffinPrice;
    addLine(s, comboCartName(picks), price);
    s.picks = []; s.groupIdx = 0; s.awaiting = null; state.set(phone, s);
    return m.extras.length ? sendExtras(phone, m, s) : reviewOrSubmit(phone, name, s);
  }

  if (selectionId === "addr:new") {
    s.awaiting = "address"; state.set(phone, s);
    return wa.sendText(phone, `Naya delivery address bhejein 🏠\n(ghar/flat no, building, area)`);
  }

  if (selectionId === "add_more") return sendMenuInteractive(phone, m, s);
  if (selectionId === "add:tiffin") return sendMenuInteractive(phone, m, s);
  if (selectionId === "add:extra") return sendExtras(phone, m, s);
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

/**
 * Send today's menu to one phone. Prefers the WhatsApp Flow — one form with
 * radio groups, real checkboxes for extras and the address, submitted once —
 * and falls back to the button/list path if the Flow isn't configured, isn't
 * usable for today's menu, or the send is rejected.
 */
async function sendMenuTo(phone, rows, address = null) {
  if (flowOrder.flowEnabled()) {
    const addr = address != null ? address : (await sheets.getCustomer(phone))?.address || "";
    if (await flowOrder.sendOrderFlow(phone, rows, addr)) return;
  }
  return sendMenuInteractive(phone, menuParse.fromSheetRows(rows || []));
}

/**
 * A submitted Flow: the entire order arrives at once, so there is no cart to
 * build up — validate it, save the address, and place the order.
 */
async function handleFlowOrder(phone, name, response) {
  if (ordersPaused) return wa.sendText(phone, `🙏 Aaj shop band hai. Kal milte hain!`);

  const rows = await sheets.getMenu();
  if (!rows || !rows.length) return wa.sendText(phone, `Menu abhi update ho raha hai 🙏 thodi der mein try karein.`);

  const parsed = flowOrder.parseFlowReply(response, rows);
  if (!parsed) {
    console.error("[flow] could not read the submission:", JSON.stringify(response));
    return wa.sendText(phone, `Order samajh nahi aaya 🙏 "menu" likh kar dobara try karein.`);
  }

  const address = parsed.address;
  if (!address) return wa.sendText(phone, `Delivery address chahiye 🏠 bhej dein, phir order lagata hun.`);
  await sheets.upsertCustomer({ phone, name, address });

  const s = freshState();
  s.cart = parsed.items;
  state.set(phone, s);
  return placeOrder(phone, name, s);
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
    if (qty > 0 && qty < 100) return addTiffinToCart(phone, name, s, m, qty);
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
  renderMenu, menuText: renderMenu, renderMenuModel, sendMenuTo, handleFlowOrder,
};
