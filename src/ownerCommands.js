const cfg = require("./config");
const sheets = require("./sheets");
const wa = require("./whatsapp");
const jobs = require("./jobs");
const logic = require("./logic");
const { freeform, parseMenu } = require("./brain");

// Single owner → module-level pending menu draft is fine.
// pendingMenu = { items:[{name,category,price|null}], needPrice:[names] }
let pendingMenu = null;

function priceList(items) {
  return items.map((it, i) => `${i + 1}. ${it.name} — ${it.price == null ? "₹?" : "₹" + it.price}`).join("\n");
}

async function showMenuDraft(owner) {
  const need = pendingMenu.needPrice;
  let msg = `📝 Aaj ka menu (draft):\n${priceList(pendingMenu.items)}`;
  if (need.length) {
    msg += `\n\n⚠️ In items ka price chahiye: ${need.join(", ")}\n` +
      `Reply karein jaise:\n${need[0]} 45${need[1] ? ", " + need[1] + " 60" : ""}`;
    await wa.sendText(owner, msg);
  } else {
    await wa.sendButtons(owner, {
      body: msg + `\n\nSab sahi hai? Confirm karte hi customers ko chala jayega.`,
      buttons: [
        { id: "menu_confirm", title: "✅ Confirm & Send" },
        { id: "menu_cancel", title: "❌ Cancel" },
      ],
    });
  }
}

// Fill prices from an owner reply like "Palak Patra 45, Puri Sabji 60".
function applyPrices(text) {
  const segs = text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  let applied = 0;
  for (const seg of segs) {
    const m = seg.match(/^(.*?)[\s:=-]+₹?(\d+(?:\.\d+)?)$/);
    if (!m) continue;
    const name = m[1].trim().toLowerCase();
    const price = Number(m[2]);
    const item = pendingMenu.items.find((it) => it.name.toLowerCase() === name)
      || pendingMenu.items.find((it) => it.name.toLowerCase().includes(name) || name.includes(it.name.toLowerCase()));
    if (item) { item.price = price; applied++; }
  }
  pendingMenu.needPrice = pendingMenu.items.filter((it) => it.price == null).map((it) => it.name);
  return applied;
}

/** Handle a message from OWNER_PHONE. Returns true if handled. */
async function handleOwner(text, selectionId = null) {
  const owner = cfg.biz.ownerPhone;
  const t = (text || "").trim().toLowerCase();

  // ----- interactive taps for the menu draft -----
  if (selectionId === "menu_confirm" && pendingMenu) {
    const items = pendingMenu.items.filter((it) => it.price != null);
    await sheets.setMenuItems(sheets.todayStr(), items);
    await sheets.upsertCatalogItems(items);
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
      `Commands:\n📋 Aaj ka menu set karne ke liye — bas apna menu paste kar dein (jaise roz bhejte hain). Main items + price nikaal ke confirm maangunga, phir customers ko bhej dunga.\n\nlist — aaj ki order + delivery list\npaid <naam/number> — payment confirm\nbroadcast — menu dobara bhejo\nband / chalu — orders pause/resume\nsummary — aaj ka hisaab`);
    return true;
  }

  // ----- price reply while a menu draft is pending -----
  if (pendingMenu && pendingMenu.needPrice.length && /\d/.test(text)) {
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
    await wa.sendText(owner, `⏳ Menu padh raha hun...`);
    const catalog = await sheets.getCatalog();
    const { items, needPrice } = await parseMenu(text, catalog);
    if (!items.length) { await wa.sendText(owner, `Menu samajh nahi aaya 🙏 thoda simple karke dobara paste karein.`); return true; }
    pendingMenu = { items, needPrice };
    await showMenuDraft(owner);
    return true;
  }

  if (isGreetingOrMenuIntent || !isQuestion) {
    // Deterministic welcome/guide — never send greetings/ambiguous text to the LLM
    // (it would hallucinate a fake menu, as seen in testing).
    await wa.sendText(owner,
      `Namaste 🙏\nAaj ka menu set karne ke liye apna *pura menu* yahan paste kar dein (jaise roz customers ko bhejte hain) 📋\nMain items + price nikaal ke confirm maangunga, phir sabko bhej dunga.\n\nCommands: list · paid <naam> · broadcast · band/chalu · summary · help`);
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
