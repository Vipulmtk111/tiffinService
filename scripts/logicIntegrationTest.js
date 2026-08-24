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
brain.customerAnswer = async () => "Delivery 1-2 baje tak ho jati hai 🛵";

const wa = require("../src/whatsapp");
const sheets = require("../src/sheets");

let pass = 0, fail = 0;
const out = [];
wa.sendText = async (to, text) => { out.push({ to, type: "text", text }); };
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
  await logic.handleMessage(CUST, "Raju", "Bhindi Thali", "item:Bhindi Thali");
  ok("tapping an item asks quantity (buttons)", last(CUST).type === "buttons" && /kitne/i.test(last(CUST).body || ""));

  reset();
  await logic.handleMessage(CUST, "Raju", "2", "qty:2");
  ok("qty adds to cart + offers add-more/review", last(CUST).type === "buttons" && last(CUST).buttons.some((b) => b.id === "review"));
  ok("cart shows 2× Bhindi = ₹240", /2× Bhindi Thali/.test(last(CUST).body || "") && /₹240/.test(last(CUST).body || ""));

  reset();
  await logic.handleMessage(CUST, "Raju", "", "review");
  ok("no address yet -> asks for address", /address/i.test(last(CUST).text || ""));

  reset();
  await logic.handleMessage(CUST, "Raju", "House 12, MG Road, near park", null);
  ok("address saved -> shows submit buttons", last(CUST).type === "buttons" && last(CUST).buttons.some((b) => b.id === "submit"));

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
  ok("draft shows both choice groups", /Suki Bhaji \/ Sev Tameta/.test(draft) && /Roti x5 \/ Thepla x4/.test(draft));
  ok("draft shows included items", /Dal Bhat, Fryms/.test(draft));
  ok("draft offers Confirm without asking for prices", last(OWNER).type === "buttons");

  reset();
  await handleOwner("", "menu_confirm");
  ok("tiffin base row saved with the .env price", menu.some((r) => r.category === "base" && r.price === cfg.biz.tiffinPrice));
  ok("choice options saved under their group", menu.filter((r) => r.category === "pick:Sabji").length === 2);
  ok("[5] read as quantity, not price", menu.some((r) => r.name === "Roti x5" && r.price === 0));
  ok("extra keeps its own price", menu.some((r) => r.category === "extra" && r.name === "Dhokla" && r.price === 40));

  console.log("\n=== CUSTOMER: tiffin ordering is pure buttons ===");
  const C2 = "919900000003";
  customers.set(C2, { phone: C2, name: "Kiran", address: "5 Park Rd" });
  reset();
  await logic.handleMessage(C2, "Kiran", "hi", null);
  ok("greeting offers the tiffin button", (last(C2).buttons || []).some((b) => b.id === "t:start"));

  reset();
  await logic.handleMessage(C2, "Kiran", "", "t:start");
  ok("first group asked", /Sabji/i.test(last(C2).body || "") && (last(C2).buttons || []).length === 2);

  reset();
  await logic.handleMessage(C2, "Kiran", "", "t:p:0:1");
  ok("second group asked after first pick", /Roti/i.test(last(C2).body || ""));

  reset();
  await logic.handleMessage(C2, "Kiran", "", "t:p:1:0");
  ok("quantity asked once all groups are picked", (last(C2).buttons || []).some((b) => b.id === "t:qty:2"));

  reset();
  await logic.handleMessage(C2, "Kiran", "", "t:qty:2");
  ok("cart totals 2 tiffins at the tiffin price", new RegExp(`${cfg.biz.tiffinPrice * 2}`).test(last(C2).body || ""));

  reset();
  await logic.handleMessage(C2, "Kiran", "", "review");
  await logic.handleMessage(C2, "Kiran", "", "submit");
  const tiffinOrder = orders[orders.length - 1];
  ok("order line names the chosen combo", /Sev Tameta \+ Roti x5/.test(tiffinOrder.items[0].name));
  ok("order amount uses the tiffin price", tiffinOrder.amount === cfg.biz.tiffinPrice * 2);

  console.log(`\n${fail === 0 ? "🎉 ALL PASS" : "⚠️  SOME FAILED"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
