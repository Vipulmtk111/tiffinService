// Offline integration test for the selection-form ordering system.
// Stubs Sheets, WhatsApp and the LLM — no network calls.
//   Owner:    paste menu -> fill missing price -> confirm -> broadcast
//   Customer: greeting -> tap item -> qty -> add-more -> review -> address -> submit
//   FAQ:      free-text question -> LLM answer (no order path)

const brain = require("../src/brain");
// Stub LLM: menu parser + customer FAQ.
brain.parseMenu = async () => ({
  items: [
    { name: "Bhindi Thali", category: "Thali", price: 120 },
    { name: "Thepla", category: "Roti/Thepla", price: 8 },
    { name: "Palak Patra", category: "Farsan", price: null },
  ],
  needPrice: ["Palak Patra"],
});
// logic.js destructures customerAnswer at require time, so the stub has to be
// indirect for a test to change the answer later.
let answerImpl = async () => "Delivery 1-2 baje tak ho jati hai 🛵";
brain.customerAnswer = async (...args) => answerImpl(...args);

const wa = require("../src/whatsapp");

// Stub the Flow sender. Without this the suite would hit the real Graph API
// and send WhatsApp messages to the fake test numbers below.
const flowOrder = require("../src/flowOrder");
const flowSends = [];
flowOrder.sendOrderFlow = async (to) => { flowSends.push(to); return null; }; // null -> caller falls back
const sheets = require("../src/sheets");

let pass = 0, fail = 0;
const out = [];
let wamid = 0;
wa.sendText = async (to, text) => {
  const id = `wamid.${++wamid}`;
  out.push({ to, type: "text", text, id });
  return { messages: [{ id }] };
};
wa.sendList = async (to, o) => { out.push({ to, type: "list", ...o }); };
wa.sendButtons = async (to, o) => { out.push({ to, type: "buttons", ...o }); };

function ok(name, cond) { if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}`); } }
function last(to) { return [...out].reverse().find((m) => m.to === to) || {}; }
function reset() { out.length = 0; }

// ---- in-memory sheet state ----
const OWNER = "919925578732";
const CUST = "919900000001";
let menu = null;
const customers = new Map();
const orders = [];
const cfg = require("../src/config");
cfg.biz.ownerPhone = OWNER;

sheets.todayStr = () => "2026-07-22";
sheets.getCatalog = async () => [];
sheets.upsertCatalogItems = async () => {};
sheets.getMenu = async () => menu;
sheets.setMenuItems = async (_d, items) => { menu = items.map((i) => ({ name: i.name, category: i.category, price: i.price })); };
sheets.getAllCustomers = async () => [...customers.values()].map((c) => ({ phone: c.phone, name: c.name }));
sheets.getCustomer = async (p) => customers.get(p) || null;
sheets.upsertCustomer = async ({ phone, name, address }) => {
  const e = customers.get(phone) || { phone, totalOrders: 0 };
  customers.set(phone, { ...e, phone, name: name || e.name, address: address || e.address });
};
sheets.addOrder = async (o) => { orders.push(o); return "20260722-001"; };
sheets.getOrders = async () => orders.map((o) => ({ ...o, status: "confirmed", payment: "pending" }));

const menuParse = require("../src/menuParse");
const logic = require("../src/logic");
const { handleOwner } = require("../src/ownerCommands");

(async () => {
  console.log("\n=== OWNER: set today's menu ===");
  reset();
  await handleOwner("# TODAY MENU #\nBhindi\nThepla\nPalak Patra\nBook before 4.30 PM", null);
  ok("draft asks for the missing price", /Palak Patra/i.test(last(OWNER).text || "") && /price|₹\?/i.test(last(OWNER).text || ""));

  reset();
  await handleOwner("Palak Patra 45", null);
  ok("after price given, shows Confirm buttons", last(OWNER).type === "buttons" && last(OWNER).buttons.some((b) => b.id === "menu_confirm"));

  reset();
  await handleOwner("", "menu_confirm");
  ok("menu saved with all 3 items", menu && menu.length === 3);
  ok("Palak Patra priced at 45", menu.find((m) => m.name === "Palak Patra").price === 45);
  ok("broadcast attempted (owner told)", out.some((m) => m.to === OWNER && /broadcast/i.test(m.text || "")));

  console.log("\n=== CUSTOMER: tap-to-order ===");
  reset();
  await logic.handleMessage(CUST, "Raju", "hi", null);
  ok("greeting sends an interactive menu list", out.some((m) => m.type === "list" && m.to === CUST));

  reset();
  await logic.handleMessage(CUST, "Raju", "", "x:0");
  ok("one tap adds the item and asks for the address (no address on file)", /address/i.test(last(CUST).text || ""));

  reset();
  await logic.handleMessage(CUST, "Raju", "House 12, MG Road, near park", null);
  ok("address saved -> shows the confirm card", last(CUST).type === "buttons" && last(CUST).buttons.some((b) => b.id === "submit"));
  ok("confirm card shows the address", /MG Road/.test(last(CUST).body || ""));

  reset();
  await logic.handleMessage(CUST, "Raju", "2", null);
  ok("a bare number on the card sets the quantity", /Bhindi Thali/.test(last(CUST).body || "") && /2× = ₹240/.test(last(CUST).body || ""));

  reset();
  await logic.handleMessage(CUST, "Raju", "", "submit");
  ok("order placed", orders.length === 1 && orders[0].amount === 240);
  ok("order has the line item", orders[0].items[0].name === "Bhindi Thali" && orders[0].items[0].qty === 2);
  ok("confirmation sent", /confirm/i.test(last(CUST).text || ""));

  console.log("\n=== OWNER: greetings & typos never hallucinate a menu ===");
  reset();
  await handleOwner("Hi", null);
  ok("owner 'Hi' -> deterministic welcome (paste guide)", /paste/i.test(last(OWNER).text || "") && last(OWNER).type === "text");

  reset();
  await handleOwner("Menu set", null);
  ok("owner 'Menu set' (no items) -> guide, not a fake menu", /paste/i.test(last(OWNER).text || "") && !/Dosa|Idli|Masala/i.test(last(OWNER).text || ""));

  reset();
  await handleOwner("Memu", null);
  ok("owner typo 'Memu' -> guide, not LLM", /paste/i.test(last(OWNER).text || ""));

  console.log("\n=== CUSTOMER: a question (LLM answers, no order) ===");
  reset();
  await logic.handleMessage("919900000002", "Asha", "kitne baje delivery hoti hai?", null);
  ok("LLM answer sent to customer", out.some((m) => m.to === "919900000002" && /delivery/i.test(m.text || "")));
  ok("owner not bothered for a simple question", !out.some((m) => m.to === OWNER));

  // ---- Tiffin menu: choice groups, no LLM anywhere in this section ----
  console.log("\n=== OWNER: tiffin menu in the agreed format (LLM disabled) ===");
  brain.parseMenu = async () => { throw new Error("LLM must not be called for the agreed format"); };
  reset();
  await handleOwner(`》SABJI..Select any

👉 SUKI BHAJI
👉 SEV TAMETA

》Select Any
1.ROTI [5]
2.THEPLA [4]

● DAL - BHAT●

●FRYMS●

EXTRA
- Dhokla - 40`, null);
  const draft = last(OWNER).text || last(OWNER).body || "";
  ok("draft shows both choice groups", /Suki Bhaji \/ Sev Tameta/.test(draft) && /5 Roti \/ 4 Thepla/.test(draft));
  ok("draft shows included items", /Dal Bhat, Fryms/.test(draft));
  ok("draft offers Confirm without asking for prices", last(OWNER).type === "buttons");

  reset();
  await handleOwner("", "menu_confirm");
  ok("tiffin base row saved with the .env price", menu.some((r) => r.category === "base" && r.price === cfg.biz.tiffinPrice));
  ok("choice options saved under their group", menu.filter((r) => r.category === "pick:Sabji").length === 2);
  // Stored as "Roti x5" (round-trips through splitQty); shown to customers as "5 Roti".
  ok("[5] read as quantity, not price", menu.some((r) => r.name === "Roti x5" && r.price === 0));
  ok("extra keeps its own price", menu.some((r) => r.category === "extra" && r.name === "Dhokla" && r.price === 40));

  console.log("\n=== CUSTOMER: a returning customer orders in 2 taps ===");
  const C2 = "919900000003";
  customers.set(C2, { phone: C2, name: "Kiran", address: "5 Park Rd" });
  reset();
  await logic.handleMessage(C2, "Kiran", "hi", null);
  const menuList = last(C2);
  const rows = (menuList.sections || []).flatMap((x) => x.rows);
  ok("greeting sends ONE list, not a chain of questions", menuList.type === "list");
  ok("every sabji×bread combo is a single row", rows.filter((r) => /^c:\d+$/.test(r.id)).length === 4);
  ok("sabji is the section heading, bread the row", (menuList.sections || [])
    .some((sec) => /SEV TAMETA/.test(sec.title) && sec.rows.some((r) => /• 5 Roti$/.test(r.title))));
  ok("no row title is truncated by WhatsApp's 24-char cap", rows.every((r) => r.title.length <= 24));
  // Extras must NOT be tappable items inside the tiffin list — a list is a radio
  // group, so tapping one there would visually deselect the tiffin.
  ok("step 1 holds tiffin rows only - nothing that could steal the selection",
    rows.every((r) => /^c:\d+$/.test(r.id)));

  // TAP 1 — pick the combo. Straight to the confirm card, no further questions.
  reset();
  await logic.handleMessage(C2, "Kiran", "", "c:2");
  const step2 = last(C2);
  ok("step 1 leads straight into step 2, extras", step2.type === "buttons" &&
    (step2.buttons || []).some((b) => /^x:\d+$/.test(b.id)));
  ok("step 2 can be skipped in one tap", (step2.buttons || []).some((b) => b.id === "review"));

  reset();
  await logic.handleMessage(C2, "Kiran", "", "review");
  const card = last(C2);
  ok("skipping extras lands on the review", card.type === "buttons");
  ok("card shows the chosen tiffin", /Tiffin \(Sev Tameta \+ 5 Roti\)/.test(card.body || ""));
  ok("card shows the saved address", /5 Park Rd/.test(card.body || ""));
  ok("review offers confirm, address change and add-more",
    ["submit", "addr:new", "add_more"].every((id) => (card.buttons || []).some((b) => b.id === id)));

  // Adding an extra must not look like it replaced the tiffin.
  reset();
  await logic.handleMessage(C2, "Kiran", "", "add_more");
  ok("'aur add karein' goes straight back to step 1, no extra hop",
    last(C2).type === "list" && (last(C2).sections || []).flatMap((x) => x.rows).some((r) => /^c:\d+$/.test(r.id)));

  ok("reopened step 1 shows the running cart", /Abhi tak/.test(last(C2).body || ""));
  const reopened = (last(C2).sections || []).flatMap((x) => x.rows);
  ok("the row already in the cart carries a ✅",
    reopened.some((r) => r.id === "c:2" && r.title.startsWith("✅") && /order mein/.test(r.description)));
  ok("rows not in the cart stay unticked and indented",
    reopened.filter((r) => r.id !== "c:2").every((r) => !r.title.startsWith("✅") && /^  • /.test(r.title)));
  ok("price is indented past the bullet, under the item text",
    reopened.every((r) => r.description.startsWith("    ")));
  ok("no extras row inside the tiffin list once the cart has something",
    !reopened.some((r) => r.id === "x:list"));
  // The extras screen is its own message, so the tiffin list is never touched.
  reset();
  await logic.handleMessage(C2, "Kiran", "", "add:extra");
  const xs = last(C2);
  ok("extras open in a separate message", xs.type === "buttons");
  ok("extras screen restates the tiffin already in the order", /Sev Tameta/.test(xs.body || ""));
  ok("each extra is its own toggle button, not one shared row",
    (xs.buttons || []).filter((b) => /^x:\d+$/.test(b.id)).length === menuParse.fromSheetRows(menu).extras.length);
  ok("buttons carry the tick state", (xs.buttons || []).every((b) => !/^x:/.test(b.id) || /^[☑☐]/u.test(b.title)));

  reset();
  await logic.handleMessage(C2, "Kiran", "", "x:0");
  const both = last(C2).body || "";
  ok("extra ADDS to the tiffin instead of replacing it",
    /Tiffin \(Sev Tameta \+ 5 Roti\)/.test(both) && /Dhokla/.test(both));
  ok("total covers tiffin + extra", new RegExp(`Total: ₹${cfg.biz.tiffinPrice + 40}`).test(both));

  // Quantity without an extra round trip. Toggling an extra leaves the customer
  // on the toggle screen, so step back to the order panel first.
  reset();
  await logic.handleMessage(C2, "Kiran", "", "review");
  reset();
  await logic.handleMessage(C2, "Kiran", "2", null);
  ok("a bare number changes the tiffin quantity", new RegExp(`${cfg.biz.tiffinPrice * 2}`).test(last(C2).body || ""));

  // Changing the address is still possible from the same card.
  reset();
  await logic.handleMessage(C2, "Kiran", "", "addr:new");
  ok("'address' button asks for a new one", /address/i.test(last(C2).text || ""));
  reset();
  await logic.handleMessage(C2, "Kiran", "9 Lake View, Satellite", null);
  ok("typed address is saved", customers.get(C2).address === "9 Lake View, Satellite");
  ok("card returns showing the NEW address", /9 Lake View/.test(last(C2).body || ""));

  // TAP 2 — confirm.
  reset();
  await logic.handleMessage(C2, "Kiran", "", "submit");
  const tiffinOrder = orders[orders.length - 1];
  ok("order line names the chosen combo", /Sev Tameta \+ 5 Roti/.test(tiffinOrder.items[0].name));
  ok("confirmation shows the delivery address", /9 Lake View, Satellite/.test(last(C2).text || ""));
  ok("order row carries the address for the delivery list", tiffinOrder.address === "9 Lake View, Satellite");
  ok("order amount uses the tiffin price", tiffinOrder.amount === cfg.biz.tiffinPrice * 2);

  console.log("\n=== SAFETY: an order is never banked without an address ===");
  const C4 = "919900000005";
  reset();
  await logic.handleMessage(C4, "Anon", "", "c:0");   // no customer record at all
  await logic.handleMessage(C4, "Anon", "", "submit");
  ok("submit without an address asks for one instead of placing the order",
    /address/i.test(last(C4).text || "") && !orders.some((o) => o.phone === C4));

  console.log("\n=== BROADCAST: the menu customers receive is orderable ===");
  const jobs = require("../src/jobs");
  reset();
  await jobs.broadcastMenu({ force: true });
  const toCust = out.filter((mm) => mm.to === C2);
  ok("broadcast sends an interactive message, not plain text", toCust.some((mm) => mm.type === "list"));
  ok("broadcast rows are tappable combos", (toCust.find((mm) => mm.type === "list")?.sections || [])
    .flatMap((x) => x.rows).some((r) => /^c:\d+$/.test(r.id)));
  ok("no 'press the button' line without a button",
    !out.some((mm) => mm.type === "text" && /button dabayein/i.test(mm.text || "")));

  // A big menu blows past the 10-row list cap, so it must degrade to step-by-step.
  console.log("\n=== CUSTOMER: too many combos -> step-by-step fallback ===");
  reset();
  await handleOwner(`SABJI (any 1)
- Bhindi
- Sev Tameta
- Suki Bhaji
- Dahi Tikhari

BREAD (any 1)
- Roti x5
- Thepla x4
- Puri x6

INCLUDED
- Dal Bhat`, null);
  await handleOwner("", "menu_confirm");
  const C3 = "919900000004";
  customers.set(C3, { phone: C3, name: "Meena", address: "1 Hill Rd" });
  reset();
  await logic.handleMessage(C3, "Meena", "hi", null);
  ok("12 combos > 10 rows -> falls back to the group-by-group button", (last(C3).buttons || []).some((b) => b.id === "t:start"));

  reset();
  await logic.handleMessage(C3, "Meena", "", "t:start");
  ok("fallback asks the first group as a list (4 options)", last(C3).type === "list");

  reset();
  await logic.handleMessage(C3, "Meena", "", "t:p:0:1");
  await logic.handleMessage(C3, "Meena", "", "t:p:1:0");
  await logic.handleMessage(C3, "Meena", "", "t:qty:1");
  ok("fallback still builds a correct cart line",
    /Sev Tameta \+ 5 Roti/.test(last(C3).body || ""));

  console.log("\n=== FLOW: one submission becomes a whole order ===");
  const C5 = "919900000006";
  reset();
  // Rebuild the 2x2 tiffin menu that the Flow describes.
  await handleOwner("SABJI (any 1)\n- Suki Bhaji\n- Sev Tameta\n\nBREAD (any 1)\n- Roti x5\n- Thepla x4\n\nINCLUDED\n- Dal Bhat\n\nEXTRA\n- Dhokla - 40", null);
  await handleOwner("", "menu_confirm");

  const flowData = flowOrder.buildFlowData(require("../src/menuParse").fromSheetRows(menu), "7 Hill Rd");
  ok("flow screen gets both choice groups as radio options",
    flowData.sabji_options.length === 2 && flowData.bread_options.length === 2 && flowData.bread_visible === true);
  ok("flow screen gets extras as checkbox options",
    flowData.extras_visible === true && flowData.extra_options[0].title === "Dhokla");
  ok("flow screen prefills the saved address", flowData.address === "7 Hill Rd");

  reset();
  await logic.handleFlowOrder(C5, "Ravi", {
    sabji: "1", bread: "0", extras: ["0"], qty: "2", address: "7 Hill Rd, Bopal",
  });
  const flowRow = orders[orders.length - 1];
  ok("submission places the order in one step", flowRow.phone === C5);
  ok("radio picks become one tiffin line",
    /Sev Tameta \+ 5 Roti/.test(flowRow.items[0].name) && flowRow.items[0].qty === 2);
  ok("checked extra is added alongside the tiffin", flowRow.items.some((i) => i.name === "Dhokla"));
  ok("total covers both", flowRow.amount === cfg.biz.tiffinPrice * 2 + 40);
  ok("address from the form is saved", customers.get(C5).address === "7 Hill Rd, Bopal");
  ok("confirmation sent to the customer", /Order confirm/.test(last(C5).text || ""));

  reset();
  await logic.handleFlowOrder(C5, "Ravi", { sabji: "0", qty: "1", address: "" });
  ok("a submission with no address places no order",
    /address/i.test(last(C5).text || "") && orders[orders.length - 1] === flowRow);

  console.log("\n=== CHECKBOX BEHAVIOUR without Flows ===");
  const C6 = "919900000007";
  customers.set(C6, { phone: C6, name: "Nita", address: "3 Rose Villa" });
  reset();
  await logic.handleMessage(C6, "Nita", "", "c:0");
  const panel1 = last(C6).body || "";
  ok("panel shows the chosen tiffin ticked", /☑ 1\u00d7 Tiffin/.test(panel1));
  ok("panel lists every extra with an empty box", /☐ Dhokla/.test(panel1));

  reset();
  await logic.handleMessage(C6, "Nita", "", "x:0");
  const panel2 = last(C6).body || "";
  ok("ticking an extra keeps the tiffin ticked too",
    /☑ 1\u00d7 Tiffin/.test(panel2) && /☑ Dhokla/.test(panel2));
  ok("both selections are visible at once - the whole point",
    (panel2.match(/☑/g) || []).length >= 2);
  ok("total reflects both", new RegExp("Total: \u20b9" + (cfg.biz.tiffinPrice + 40)).test(panel2));

  reset();
  await logic.handleMessage(C6, "Nita", "", "add:extra");

  ok("reopened extras screen shows the ticked one as ticked",
    (last(C6).buttons || []).some((b) => b.id === "x:0" && b.title.startsWith("☑")));

  // Tapping again raises the quantity rather than clearing it.
  reset();
  await logic.handleMessage(C6, "Nita", "", "x:0");
  const panel3 = last(C6).body || "";
  ok("second tap makes it 2x", /☑ Dhokla \u2014 2\u00d7/.test(panel3));
  ok("total counts both", new RegExp("Total: \u20b9" + (cfg.biz.tiffinPrice + 80)).test(panel3));
  ok("button label carries the quantity",
    (last(C6).buttons || []).some((b) => b.id === "x:0" && /2\u00d7 Dhokla/.test(b.title)));

  // Past the cap it clears, so undoing is never more than one extra tap.
  reset();
  await logic.handleMessage(C6, "Nita", "", "x:0");   // 3x
  await logic.handleMessage(C6, "Nita", "", "x:0");   // cleared
  const panel4 = last(C6).body || "";
  ok("one more tap past the cap clears it", /☐ Dhokla/.test(panel4));
  ok("tiffin survives the whole cycle", /☑ 1\u00d7 Tiffin/.test(panel4));
  ok("total returns to the tiffin alone", new RegExp("Total: \u20b9" + cfg.biz.tiffinPrice).test(panel4));

  console.log("\n=== CUSTOMER QUESTIONS: forward and answer ===");
  const C7 = "919900000008";
  customers.set(C7, { phone: C7, name: "Asha", address: "8 Green Park" });

  // A mid-order address must never be mistaken for a question, however short.
  reset();
  await logic.handleMessage(C7, "Asha", "", "c:0");
  await logic.handleMessage(C7, "Asha", "", "review");
  reset();
  await logic.handleMessage(C7, "Asha", "", "addr:new");
  reset();
  await logic.handleMessage(C7, "Asha", "A-12", null);
  ok("a short address is accepted, not forwarded to the owner",
    customers.get(C7).address === "A-12" && !out.some((m) => m.to === OWNER));

  // A real question does go to the owner, and the owner can answer it.
  answerImpl = async () => "FORWARD";
  reset();
  await logic.handleMessage(C7, "Asha", "50 tiffin ka bulk order ho payega?", null);
  const fwd = out.find((m) => m.to === OWNER);
  ok("a question the bot cannot answer reaches the owner", !!fwd && /bulk order/.test(fwd.text || ""));

  reset();
  await handleOwner("Haan bhai, kal subah tak ho jayega", null, fwd.id);
  ok("owner's swipe-reply is delivered to the customer who asked",
    out.some((m) => m.to === C7 && /kal subah tak/.test(m.text || "")));
  ok("owner is told it was sent", out.some((m) => m.to === OWNER && /bhej diya/.test(m.text || "")));

  reset();
  await handleOwner("r ₹75 per tiffin bulk rate", null, null);
  ok("\"r <jawab>\" answers the last customer who asked",
    out.some((m) => m.to === C7 && /75 per tiffin/.test(m.text || "")));

  answerImpl = async () => "Delivery 1-2 baje tak ho jati hai 🛵";

  console.log(`\n${fail === 0 ? "🎉 ALL PASS" : "⚠️  SOME FAILED"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
