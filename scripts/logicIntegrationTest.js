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

  console.log(`\n${fail === 0 ? "🎉 ALL PASS" : "⚠️  SOME FAILED"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
