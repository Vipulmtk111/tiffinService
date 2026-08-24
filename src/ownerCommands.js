const cfg = require("./config");
const sheets = require("./sheets");
const wa = require("./whatsapp");
const jobs = require("./jobs");
const logic = require("./logic");
const { freeform, parseMenu } = require("./brain");
const menuParse = require("./menuParse");

/** The agreed format, shown whenever a paste can't be read. */
function formatHelp() {
  return `Menu samajh nahi aaya 🙏\n\nAise bhejein 👇\n\n` +
    `TIFFIN - ${cfg.biz.tiffinPrice}\n\n` +
    `SABJI (any 1)\n- Suki Bhaji\n- Sev Tameta\n\n` +
    `BREAD (any 1)\n- Roti x5\n- Thepla x4\n\n` +
    `INCLUDED\n- Dal Bhat\n- Fryms\n\n` +
    `EXTRA\n- Dhokla - 40\n\n` +
    `👉 x5 = kitne milenge. EXTRA ka number = price.`;
}

// Single owner → module-level pending menu draft is fine.
// pendingMenu = the parsed model from menuParse.parseMenuText()
let pendingMenu = null;

/** Extras listed without a price can't be sold — ask the owner for them. */
function extrasNeedingPrice(m) {
  return m.extras.filter((e) => e.price == null).map((e) => e.name);
}

async function showMenuDraft(owner) {
  const need = extrasNeedingPrice(pendingMenu);
  const body = `📝 Aaj ka menu (draft):\n\n${logic.renderMenuModel(pendingMenu)}`;
  if (need.length) {
    await wa.sendText(owner,
      `${body}\n\n⚠️ In extra items ka price chahiye: ${need.join(", ")}\n` +
      `Reply karein jaise:\n${need[0]} 45${need[1] ? ", " + need[1] + " 60" : ""}`);
    return;
  }
  await wa.sendButtons(owner, {
    body: `${body}\n\nSab sahi hai? Confirm karte hi customers ko chala jayega.`,
    buttons: [
      { id: "menu_confirm", title: "✅ Confirm & Send" },
      { id: "menu_cancel", title: "❌ Cancel" },
    ],
  });
}

// Fill missing EXTRA prices from an owner reply like "Dhokla 45, Samosa 15".
function applyPrices(text) {
  const segs = text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  let applied = 0;
  for (const seg of segs) {
    const m = seg.match(/^(.*?)[\s:=-]+₹?(\d+(?:\.\d+)?)$/);
    if (!m) continue;
    const name = m[1].trim().toLowerCase();
    const price = Number(m[2]);
    const item = pendingMenu.extras.find((it) => it.name.toLowerCase() === name)
      || pendingMenu.extras.find((it) => it.name.toLowerCase().includes(name) || name.includes(it.name.toLowerCase()));
    if (item) { item.price = price; applied++; }
  }
  return applied;
}

/** Handle a message from OWNER_PHONE. Returns true if handled. */
async function handleOwner(text, selectionId = null, contextId = null) {
  const owner = cfg.biz.ownerPhone;
  const t = (text || "").trim().toLowerCase();

  // ----- answering a forwarded customer question -----
  // Swipe-replying to the forwarded message is the natural gesture; WhatsApp
  // sends the quoted message's id, which tells us exactly who asked.
  const quoted = logic.forwardTarget(contextId);
  if (quoted && text && !selectionId) {
    await logic.replyToCustomer(quoted, text);
    await wa.sendText(owner, `✅ ${quoted.name || quoted.phone} ko bhej diya.`);
    return true;
  }
  // "r <jawab>" answers whoever asked last — for when the owner types a fresh
  // message instead of replying to the forwarded one.
  const rMatch = (text || "").match(/^r\s+(.+)$/is);
  if (rMatch) {
    const target = logic.lastForwardTarget();
    if (!target) { await wa.sendText(owner, `Abhi koi customer sawaal pending nahi hai 🙂`); return true; }
    await logic.replyToCustomer(target, rMatch[1].trim());
    await wa.sendText(owner, `✅ ${target.name || target.phone} ko bhej diya.`);
    return true;
  }

  // ----- interactive taps for the menu draft -----
  if (selectionId === "menu_confirm" && pendingMenu) {
    // Drop extras still missing a price — they can't be sold.
    pendingMenu.extras = pendingMenu.extras.filter((e) => e.price != null);
    const rows = menuParse.toSheetRows(pendingMenu, cfg.biz.tiffinPrice);
    await sheets.setMenuItems(sheets.todayStr(), rows);
    // Only priced à-la-carte items belong in the reusable price book.
    await sheets.upsertCatalogItems(pendingMenu.extras.map((e) => ({ name: e.name, category: "Extra", price: e.price })));
    pendingMenu = null;
    await wa.sendText(owner, `✅ Menu set! Ab sabhi customers ko bhej raha hun...`);
    await jobs.broadcastMenu({ force: true });
    return true;
  }
  if (selectionId === "menu_cancel") { pendingMenu = null; await wa.sendText(owner, `❌ Menu cancel. Dobara paste karein jab ready ho.`); return true; }

  // ----- fixed commands -----
  if (t === "list") { await jobs.kitchenList(); return true; }
  if (t === "summary" || t === "hisaab") { await jobs.dailySummary(); return true; }
  if (t === "broadcast") { await jobs.broadcastMenu({ force: true }); return true; }
  if (t === "format" || t === "sample") { await wa.sendText(owner, formatHelp()); return true; }
  if (t === "band") { logic.setPaused(true); await wa.sendText(owner, "🔴 Orders PAUSED. 'chalu' bhej kar resume karein."); return true; }
  if (t === "chalu") { logic.setPaused(false); await wa.sendText(owner, "🟢 Orders RESUMED."); return true; }

  const paidMatch = text.match(/^paid\s+(.+)$/i);
  if (paidMatch) {
    const target = paidMatch[1].trim().toLowerCase();
    const digits = target.replace(/\D/g, "");
    const orders = (await sheets.getOrders()).filter((o) =>
      o.payment === "pending" &&
      ((digits.length >= 5 && o.phone.includes(digits)) || (o.name || "").toLowerCase().includes(target)));
    if (!orders.length) { await wa.sendText(owner, `❓ "${paidMatch[1]}" ka pending order nahi mila aaj.`); return true; }
    for (const o of orders) await sheets.setOrderField(o.row, sheets.COL.payment, "paid");
    await wa.sendText(owner, `✅ Paid mark kiya: ${orders.map((o) => `${o.name || o.phone} ₹${o.amount}`).join(", ")}`);
    return true;
  }

  if (t === "help") {
    await wa.sendText(owner,
      `Commands:\n📋 Aaj ka menu set karne ke liye menu paste karein — format dekhne ke liye "format" bhejein.\n\nlist — aaj ki order + delivery list\nr <jawab> — customer ke sawaal ka jawab (ya us message pe reply karein)\npaid <naam/number> — payment confirm\nbroadcast — menu dobara bhejo\nband / chalu — orders pause/resume\nsummary — aaj ka hisaab`);
    return true;
  }

  // ----- price reply while a menu draft is pending -----
  if (pendingMenu && extrasNeedingPrice(pendingMenu).length && /\d/.test(text)) {
    const n = applyPrices(text);
    if (n) { await showMenuDraft(owner); return true; }
  }

  // ----- classify the message -----
  const multiLine = text.includes("\n");
  // A single-line comma list of items ("Idli 30, Dosa 35, Poha 25") counts as a paste.
  const looksLikeItemList = /,/.test(text) && /\d/.test(text) && text.trim().length >= 15;
  const isMenuPaste = multiLine || looksLikeItemList;

  const isQuestion = /\?/.test(text) ||
    /\b(kitn[ae]|kya|kaun|kab|kitna|how|what|when|which|total|revenue|profit|hisaab|kaise|konsa)\b/i.test(t);

  // Greeting or "set the menu" intent WITHOUT any actual items -> guide the owner.
  const isGreetingOrMenuIntent =
    /^(hi+|hello+|hey+|namaste|namaskar|start|good\s*(morning|afternoon|evening|night))\b/i.test(t) ||
    /^(menu|men?u\s*(set|update|new)?|set\s*menu|new\s*menu|update\s*menu|aaj\s*ka\s*menu|today'?s?\s*menu)\??$/i.test(t);

  if (isMenuPaste) {
    // Agreed format: parsed locally, instantly, no LLM.
    let model = menuParse.parseMenuText(text);
    if (!menuParse.hasContent(model)) {
      // Paste that ignores the format — fall back to the LLM, but a rate limit
      // or outage must not block the owner, so failure lands on the format help.
      await wa.sendText(owner, `⏳ Menu padh raha hun...`);
      const catalog = await sheets.getCatalog();
      const { items } = await parseMenu(text, catalog);
      model = { tiffinPrice: null, groups: [], included: [], extras: items, ignored: 0, sawHeader: false };
    }
    if (!menuParse.hasContent(model)) { await wa.sendText(owner, formatHelp()); return true; }
    pendingMenu = model;
    await showMenuDraft(owner);
    return true;
  }

  if (isGreetingOrMenuIntent || !isQuestion) {
    // Deterministic welcome/guide — never send greetings/ambiguous text to the LLM
    // (it would hallucinate a fake menu, as seen in testing).
    await wa.sendText(owner,
      `Namaste 🙏\nAaj ka menu paste kar dein 📋 Main draft bana ke confirm maangunga, phir sabko bhej dunga.\n\nFormat dekhne ke liye "format" bhejein.\n\nCommands: list · paid <naam> · broadcast · band/chalu · summary · help`);
    return true;
  }

  // ----- genuine question -> grounded Q&A (strictly from today's data) -----
  const orders = await sheets.getOrders();
  const menu = await sheets.getMenu();
  const ctx =
    `You are a helpful assistant for a tiffin shop OWNER. Answer briefly in Hinglish, ONLY from the data below. ` +
    `NEVER invent menu items, prices, orders or customers. If the data doesn't contain the answer, say "abhi data mein nahi hai".\n` +
    `Today's menu: ${menu && menu.length ? menu.map((m) => `${m.name} ₹${m.price}`).join(", ") : "(not set yet)"}\n` +
    `Today's orders: ${JSON.stringify(orders.map(({ name, items, amount, payment, status }) => ({ name, items, amount, payment, status })))}`;
  const ans = await freeform(`${ctx}\n\nOwner asks: ${text}`);
  await wa.sendText(owner, ans || `Samajh nahi aaya 🙏 'help' bhej kar commands dekhein.`);
  return true;
}

module.exports = { handleOwner };
