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

function freshState() { return { cart: [], awaiting: null, picks: [], groupIdx: 0, lastLine: null, appendTo: null }; }

// ---------- rendering ----------
const optLabel = menuParse.optDisplay;

/**
 * Human-readable menu from the parsed model.
 * `cta` appends the "tap the button" line — only true where a button/list is
 * actually attached, never on the owner's draft or the morning reminder.
 */
function renderMenuModel(m, { cta = false } = {}) {
  const b = cfg.biz;
  let out = `🍱 *${b.shopName}* — today's menu\n`;

  if (menuParse.isTiffinMenu(m)) {
    const price = m.tiffinPrice != null ? m.tiffinPrice : b.tiffinPrice;
    out += `\n*TIFFIN — ₹${price}*\n`;
    for (const g of m.groups) out += `• ${g.name} (choose 1): ${g.options.map(optLabel).join(" / ")}\n`;
    if (m.included.length) out += `• Included: ${m.included.map(optLabel).join(", ")}\n`;
  }

  if (m.extras.length) {
    out += `\n*EXTRA*\n` + m.extras.map((e) => `• ${e.name} — ₹${e.price}`).join("\n") + "\n";
  }

  if (cta) out += `\nTap the button below to order 👇`;
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
  const buttons = [{ id: "t:start", title: "🍱 Order tiffin" }];
  if (m.extras.length) buttons.push({ id: "x:list", title: "➕ Extras" });
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
  const incl = m.included.length ? `\n🍚 Every tiffin includes: ${m.included.map(menuParse.optDisplay).join(", ")}` : "";
  const sections = [];

  // What's already in the cart, so rows can carry a ✅ instead of looking unpicked.
  const inCart = new Map((s?.cart || []).map((i) => [i.name, i.qty]));

  /** Indented, tick-marked row. NBSP survives any client that trims spaces. */
  const row = (id, cartName, label, rupees) => {
    const qty = inCart.get(cartName);
    return {
      id,
      title: qty ? `✅ ${label}` : `  • ${label}`,
      description: qty ? `    ₹${rupees} · ${qty} in order` : `    ₹${rupees}`,
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

  // No extras row here on purpose. This list has ONE job - pick the tiffin -
  // and a list is a single radio group, so any other row would move the
  // selection off the tiffin. Extras follow automatically as step 2.
  const extrasNote = m.extras.length
    ? `\n\n➕ Extras come in step 2: ${m.extras.map((e) => `${e.name} ₹${e.price}`).join(", ")}`
    : "";

  const cart = s && s.cart.length
    ? `\n\n🧾 So far: ${s.cart.map((i) => `${i.qty}× ${i.name}`).join(", ")}`
    : "";

  return wa.sendList(phone, {
    header: "Today's menu 🍱",
    body: `🍱 *${cfg.biz.shopName}*\n\n*Step 1 — Choose your tiffin (₹${price})*${incl}${extrasNote}${cart}`,
    buttonText: "Choose tiffin 🍱",
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
  const cart = s?.cart || [];
  const qtyOf = (nm) => (cart.find((i) => i.name === nm) || {}).qty || 0;

  // Only what is actually in the order. Re-listing every extra with an empty
  // box after each tap reads as the bot asking again; the buttons already say
  // what can still be added.
  const chosen = cart.map((i) => `\u2705 ${i.qty}\u00d7 ${i.name} \u2014 \u20b9${i.price * i.qty}`).join("\n");
  const rest = m.extras.filter((e) => !qtyOf(e.name));
  const restLine = rest.map((e) => `${e.name} \u20b9${e.price}`).join(" \u00b7 ");
  const picked = m.extras.some((e) => qtyOf(e.name) > 0);

  const prompt = picked
    ? (rest.length ? `\u2795 Add more? ${restLine}` : "\u2795 All extras added")
    : `*Step 2 \u2014 Any extras?* (optional)\n${restLine}`;

  return wa.sendButtons(phone, {
    body: `\ud83e\uddfe *Your order*\n${chosen}\n*Total: \u20b9${cartTotal(cart)}*\n\n${prompt}`,
    buttons: [
      ...m.extras.map((e, i) => {
        const q = qtyOf(e.name);
        return {
          id: `x:${i}`,
          title: q ? `\u2611 ${e.name}` : `\u2610 ${e.name}`,
        };
      }),
      { id: "review", title: picked ? "\u2705 Done, review" : "\u23ed\ufe0f Skip extras" },
    ],
  });
}

/** Toggle buttons when they fit, otherwise the tick-marked list. */
async function sendExtras(phone, m, s) {
  return extrasFitButtons(m) ? sendExtrasToggle(phone, m, s) : sendExtrasList(phone, m, null, s);
}

async function sendExtrasList(phone, m, body, s = null) {
  if (!m.extras.length) return wa.sendText(phone, `No extras available today 🙏`);
  const inCart = new Map((s?.cart || []).map((i) => [i.name, i.qty]));
  const tiffin = (s?.cart || []).filter((i) => i.name.startsWith("Tiffin"));

  return wa.sendList(phone, {
    header: "Extras ➕",
    body: body || (tiffin.length
      ? `✅ Your tiffin is in the order:\n${tiffin.map((i) => `• ${i.qty}× ${i.name}`).join("\n")}\n\nAdd extras — your tiffin stays as it is 👇`
      : `Which extras would you like? 👇\n(tap to add \u00b7 tap again to remove)`),
    buttonText: "Choose extras ➕",
    sections: [{
      title: "➕ EXTRA",
      rows: m.extras.map((e, i) => {
        const line = (s?.cart || []).find((c) => c.name === e.name);
        return {
          id: `x:${i}`,
          title: line ? `☑ ${e.name}` : `☐ ${e.name}`,
          description: line
            ? `    ₹${e.price} · tap to remove`
            : `    ₹${e.price} · tap to add`,
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
  const body = `${chosen ? `✅ ${chosen}\n\n` : ""}*${g.name}* — choose 1 👇`;

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
  const incl = m.included.length ? `\nIncluded: ${m.included.map(optLabel).join(", ")}` : "";
  return wa.sendButtons(phone, {
    body: `🍱 *${menuParse.comboLabel(s.picks)}*${incl}\n₹${price} per tiffin\n\nHow many tiffins?`,
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

// Forwarded customer questions, keyed by the id of the message the OWNER
// received. WhatsApp puts that id in context.id when the owner swipe-replies,
// which is how a reply finds its way back to the right customer.
const forwards = new Map();      // ownerMessageId -> { phone, name }
let lastForward = null;          // fallback for "r <message>"

function rememberForward(id, phone, name) {
  if (!id) return;
  forwards.set(id, { phone, name });
  lastForward = { phone, name };
  // Keep the map from growing without bound over a long-running process.
  if (forwards.size > 500) forwards.delete(forwards.keys().next().value);
}

/** Who a swipe-reply belongs to, or null. */
function forwardTarget(contextId) { return (contextId && forwards.get(contextId)) || null; }
function lastForwardTarget() { return lastForward; }

/** Today's live orders for one customer (cancelled ones don't count). */
async function todaysOrders(phone) {
  const all = await sheets.getOrders();
  return all.filter((o) => o.phone === phone && o.status !== "cancelled");
}

/**
 * A customer who already ordered today gets asked what they meant, instead of
 * silently starting a second order. Adding to the existing one keeps the
 * kitchen list and the bill as a single entry per customer.
 */
async function sendExistingOrderChoice(phone, name, orders) {
  const lines = orders.map((o) =>
    `#${o.id} \u2014 ${o.items.map((i) => `${i.qty}\u00d7 ${i.name}`).join(", ")} \u2014 \u20b9${o.amount}`).join("\n");
  return wa.sendButtons(phone, {
    body: `Hello ${name || ""}! \ud83d\ude4f\n\n` +
      `You already have an order today:\n${lines}\n\n` +
      `What would you like to do?`,
    buttons: [
      { id: "ord:add", title: "\u2795 Add to it" },
      { id: "ord:new", title: "\ud83c\udd95 New order" },
      { id: "ord:cancel", title: "\u274c Cancel it" },
    ],
  });
}

async function forwardToOwner(phone, name, text) {
  const res = await wa.sendText(cfg.biz.ownerPhone,
    `👤 *${name || phone}* asked:\n"${text}"\n\n` +
    `↩️ Reply to this message — it goes straight to the customer.\n` +
    `(or send "r <your reply>")`);
  rememberForward(res?.messages?.[0]?.id, phone, name);
}

/** Owner's answer -> the customer who asked. Returns true when delivered. */
async function replyToCustomer(target, text) {
  if (!target?.phone) return false;
  await wa.sendText(target.phone, `👨‍🍳 *${cfg.biz.shopName}*:\n${text}`);
  return true;
}

/**
 * The single confirm card — cart, total and the delivery address in one message.
 * The saved address is shown (never applied silently) and changed from the same
 * card, so a returning customer's whole order is two taps: pick, confirm.
 */
async function reviewOrSubmit(phone, name, s) {
  if (!s.cart.length) return wa.sendText(phone, `Your cart is empty 🙂 Send "menu" to start an order.`);
  const customer = await sheets.getCustomer(phone);
  if (!customer || !customer.address) {
    s.awaiting = "address"; state.set(phone, s);
    return wa.sendText(phone, `${cartSummary(s.cart)}\nTotal: ₹${cartTotal(s.cart)} 👍\n\nPlease send your delivery address (house/flat no, building, area) 🏠`);
  }
  s.awaiting = "confirm"; state.set(phone, s);
  const m = menuParse.fromSheetRows(await sheets.getMenu());
  return wa.sendButtons(phone, {
    body: renderOrderPanel(s, m, customer.address),
    buttons: [
      { id: "submit", title: "✅ Confirm order" },
      { id: "addr:new", title: "✏️ Change address" },
      { id: "add_more", title: "➕ Add more" },
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
  const lines = s.cart.map((i) => `\u2705 ${i.qty}\u00d7 ${i.name} \u2014 \u20b9${i.price * i.qty}`).join("\n");
  // Extras not ordered are deliberately absent: this screen is the order, and
  // listing the rest with empty boxes made customers think it was asking again.
  const addNote = s.appendTo ? `\n(adding to your earlier order #${s.appendTo.id})` : "";
  return `\ud83e\uddfe *Your order*${addNote}\n\n${lines}\n\u2014 \u2014 \u2014\n*Total: \u20b9${cartTotal(s.cart)}*\n\n` +
    `\ud83d\udccd *Delivery address:*\n${address}`;
}

async function placeOrder(phone, name, s) {
  const customer = await sheets.getCustomer(phone);
  const address = (customer?.address || "").trim();
  // Never bank an order we can't deliver — that lands as "address?" on the
  // owner's delivery list with no way to recover it.
  if (!address) {
    s.awaiting = "address"; state.set(phone, s);
    return wa.sendText(phone, `We need a delivery address before placing the order 🏠\n(house/flat no, building, area)`);
  }
  const amount = cartTotal(s.cart);

  // Adding to an order placed earlier today: merge into that row rather than
  // creating a second one, so the kitchen list and the bill stay one entry.
  if (s.appendTo) {
    const live = (await todaysOrders(phone)).find((o) => o.id === s.appendTo.id);
    if (live) {
      const merged = live.items.map((i) => ({ ...i }));
      for (const add of s.cart) {
        const at = merged.find((i) => i.name === add.name);
        if (at) at.qty += add.qty;
        else merged.push({ ...add });
      }
      const newAmount = merged.reduce((n, i) => n + i.price * i.qty, 0);
      await sheets.amendOrder(live.row, merged, newAmount);
      state.delete(phone);
      // The kitchen list may already have gone out, so the owner must be told.
      await wa.sendText(cfg.biz.ownerPhone,
        `➕ *Order updated* — #${live.id}\n${customer?.name || name || phone}\n` +
        `Added: ${cartSummary(s.cart)}\nNew total: ₹${newAmount}`);
      return wa.sendText(phone,
        `Order *#${live.id}* updated ✅\n\n${cartSummary(merged)}\n— — —\nTotal: ₹${newAmount}\n\n` +
        `📍 *Delivery address:*\n${address}\n\nThank you 🙂`);
    }
    // The order vanished (cancelled elsewhere) — fall through and place a new one.
    s.appendTo = null;
  }

  const id = await sheets.addOrder({
    date: sheets.todayStr(), phone, name: customer?.name || name,
    items: s.cart, amount, address,
  });
  state.delete(phone);
  return wa.sendText(phone,
    `Order confirmed ✅ (#${id})\n\n${cartSummary(s.cart)}\n— — —\nTotal: ₹${amount}\n\n` +
    `📍 *Delivery address:*\n${address}\n\n` +
    `If the address is wrong, tell us now 🙏\nWe'll deliver soon. Thank you 🙂`);
}

/** "Isme aur add" / "Alag naya order" from the repeat-customer prompt. */
async function chooseExistingOrder(phone, name, s, m, selectionId) {
  const existing = await todaysOrders(phone);
  if (selectionId === "ord:add") {
    if (!existing.length) return wa.sendText(phone, `No order found for today \ud83d\ude4f`);
    const target = existing[existing.length - 1];   // newest, if somehow several
    s.appendTo = { row: target.row, id: target.id };
    await wa.sendText(phone, `Got it \u2014 adding to order *#${target.id}* \ud83d\udc4d`);
  } else {
    s.appendTo = null;
  }
  s.cart = []; s.awaiting = null; s.picks = []; s.groupIdx = 0; s.lastLine = null;
  state.set(phone, s);
  return sendMenuInteractive(phone, m, s);
}

/** Cancel today's order. The owner is told, since the kitchen may have it. */
async function cancelExistingOrder(phone, name, s) {
  void s;
  const existing = await todaysOrders(phone);
  if (!existing.length) return wa.sendText(phone, `No order found for today \ud83d\ude4f`);
  const target = existing[existing.length - 1];
  await sheets.setOrderField(target.row, sheets.COL.status, "cancelled");
  state.delete(phone);
  await wa.sendText(cfg.biz.ownerPhone,
    `\u274c *Order cancelled* \u2014 #${target.id}\n${name || phone} \u2014 \u20b9${target.amount}`);
  return wa.sendText(phone,
    `Order *#${target.id}* has been cancelled \u274c\nSend "menu" whenever you want to order again \ud83d\ude4f`);
}

// ---------- interactive taps ----------
/** Returns a promise when the tap was handled, or null to fall through to text. */
function handleTap(phone, name, s, m, selectionId, menuAvailable) {
  const notReady = () => wa.sendText(phone, `The menu is being updated 🙏`);

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
    if (!option) return wa.sendText(phone, `That option isn't available today 🙏`);
    // Re-taps of an earlier group replace that pick instead of appending.
    s.picks = s.picks.slice(0, Number(gi));
    s.picks.push(option);
    s.groupIdx = Number(gi) + 1;
    state.set(phone, s);
    return askGroup(phone, s, m);
  }

  if (selectionId.startsWith("t:qty:")) {
    if (!menuAvailable) return notReady();
    if (!s.picks.length) return wa.sendText(phone, `Please choose your tiffin options first 🙏 Send "menu".`);
    return addTiffinToCart(phone, name, s, m, Number(selectionId.slice(6)) || 1);
  }

  if (selectionId === "x:list") {
    if (!menuAvailable) return notReady();
    return sendExtras(phone, m, s);
  }

  if (/^x:\d+$/.test(selectionId)) {
    if (!menuAvailable) return notReady();
    const e = m.extras[Number(selectionId.slice(2))];
    if (!e) return wa.sendText(phone, `That item isn't available today 🙏`);
    // Plain on/off. Tap adds it, tap again removes it - nothing to learn.
    const at = s.cart.findIndex((i) => i.name === e.name);
    if (at < 0) {
      addLine(s, e.name, e.price);
    } else {
      s.cart.splice(at, 1);
      if (s.lastLine === e.name) s.lastLine = null;
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
    if (!picks) return wa.sendText(phone, `That option isn't available today 🙏`);
    const price = m.tiffinPrice != null ? m.tiffinPrice : cfg.biz.tiffinPrice;
    addLine(s, comboCartName(picks), price);
    s.picks = []; s.groupIdx = 0; s.awaiting = null; state.set(phone, s);
    return m.extras.length ? sendExtras(phone, m, s) : reviewOrSubmit(phone, name, s);
  }

  // ----- what to do about today's existing order -----
  if (selectionId === "ord:add" || selectionId === "ord:new") {
    return chooseExistingOrder(phone, name, s, m, selectionId);
  }
  if (selectionId === "ord:cancel") return cancelExistingOrder(phone, name, s);
  if (selectionId === "addr:new") {
    s.awaiting = "address"; state.set(phone, s);
    return wa.sendText(phone, `Please send the new delivery address 🏠\n(house/flat no, building, area)`);
  }

  if (selectionId === "add_more") return sendMenuInteractive(phone, m, s);
  if (selectionId === "add:tiffin") return sendMenuInteractive(phone, m, s);
  if (selectionId === "add:extra") return sendExtras(phone, m, s);
  if (selectionId === "review") return reviewOrSubmit(phone, name, s);
  if (selectionId === "submit") return s.cart.length ? placeOrder(phone, name, s) : wa.sendText(phone, `Your cart is empty 🙂`);
  if (selectionId === "edit") {
    s.cart = []; s.awaiting = null; s.picks = []; s.groupIdx = 0; s.lastLine = null;
    state.set(phone, s);
    return sendMenuInteractive(phone, m);
  }
  if (selectionId === "cancel") { state.delete(phone); return wa.sendText(phone, `Order cancelled ❌ Order again whenever you like 🙏`); }
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
  if (ordersPaused) return wa.sendText(phone, `🙏 We're closed today. See you tomorrow!`);

  const rows = await sheets.getMenu();
  if (!rows || !rows.length) return wa.sendText(phone, `The menu is being updated 🙏 please try again shortly.`);

  const parsed = flowOrder.parseFlowReply(response, rows);
  if (!parsed) {
    console.error("[flow] could not read the submission:", JSON.stringify(response));
    return wa.sendText(phone, `Sorry, we couldn't read that order 🙏 Send "menu" to try again.`);
  }

  const address = parsed.address;
  if (!address) return wa.sendText(phone, `We need a delivery address 🏠 Send it and I'll place the order.`);
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

  if (ordersPaused) return wa.sendText(phone, `🙏 We're closed today. See you tomorrow!`);

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
  // Once we've asked for an address, whatever the customer sends IS the address.
  // A length rule here used to drop short ones through to the LLM and forward
  // them to the owner, leaving the customer stuck mid-order.
  if (s.awaiting === "address") {
    const addr = text.trim();
    if (addr.length < 3) {
      return wa.sendText(phone, `Please send a fuller address 🙏\n(house/flat no, building, area)`);
    }
    await sheets.upsertCustomer({ phone, name, address: addr });
    s.awaiting = null; state.set(phone, s);
    await wa.sendText(phone, `Address saved ✅`);
    return reviewOrSubmit(phone, name, s);
  }

  // ===== greeting / menu request =====
  if (/^(hi|hii|hello|hey|namaste|namaskar|menu|order|start|good\s*(morning|evening|afternoon))/i.test(lower) || lower === "") {
    if (!menuAvailable) return wa.sendText(phone, `Hello ${name || ""}! 🙏 Today's menu is being updated, we'll send it shortly.`);
    // Already ordered today? Ask what they meant before starting a second one.
    if (!s.cart.length) {
      const existing = await todaysOrders(phone);
      if (existing.length) return sendExistingOrderChoice(phone, name, existing);
    }
    await wa.sendText(phone, `Hello ${name || ""}! 🙏`);
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
  if (/^(nahi|no|cancel)$/i.test(lower)) { state.delete(phone); return wa.sendText(phone, `Cancelled ❌ 🙏`); }

  // ===== anything else -> LLM answers the QUESTION (never orders) =====
  const answer = await customerAnswer(text, {
    shopName: b.shopName, menu: {}, snacks: m.extras.map((e) => ({ item: e.name, price: e.price })),
    tiffinPrice: m.tiffinPrice != null ? m.tiffinPrice : b.tiffinPrice,
    includedRotis: b.includedRotis, extraRotiPrice: b.extraRotiPrice,
    orderCutoff: b.orderCutoff, deliveryNote: b.radiusNote,
  });
  if (answer && answer !== "FORWARD") {
    await wa.sendText(phone, answer);
    if (menuAvailable) return wa.sendText(phone, `Send "menu" to place an order 🍱`);
    return;
  }
  await forwardToOwner(phone, name, text);
  return wa.sendText(phone, `One moment 🙏 I've passed this to the owner, they'll reply.`);
}

module.exports = {
  handleMessage, setPaused, isPaused,
  renderMenu, menuText: renderMenu, renderMenuModel, sendMenuTo, handleFlowOrder,
  forwardTarget, lastForwardTarget, replyToCustomer,
};
