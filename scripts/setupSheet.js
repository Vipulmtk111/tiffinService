/* One-time setup: creates tabs + headers + placeholder snacks in your Google Sheet.
   Run: npm run setup-sheet  */
const { google } = require("googleapis");
const cfg = require("../src/config");

const TABS = {
  Catalog: ["Name", "Category", "Price", "Unit", "Active(Y/N)"],
  Menu: ["Date", "Name", "Category", "Price", "Available(Y/N)"],
  Customers: ["Phone", "Name", "Address", "FirstOrderDate", "LastOrderDate", "TotalOrders"],
  Orders: ["Date", "Time", "Phone", "Name", "Items", "Amount", "Address", "Status", "PaymentStatus", "OrderID"],
  DailyLog: ["Date", "TotalOrders", "TotalItems", "Revenue", "Collected", "Pending"],
};

// Seed the price book with the owner's common items (edit prices in the sheet anytime).
const PLACEHOLDER_CATALOG = [
  ["Bhindi Thali", "Thali", 120, "plate", "Y"],
  ["Dahi Tikhari Thali", "Thali", 120, "plate", "Y"],
  ["Roti", "Roti/Thepla", 5, "each", "Y"],
  ["Thepla", "Roti/Thepla", 8, "each", "Y"],
  ["Dal Bhat", "Add-on", 40, "plate", "Y"],
  ["Fryms", "Add-on", 20, "plate", "Y"],
  ["Dhokla", "Farsan", 40, "plate", "Y"],
  ["Khandvi", "Farsan", 50, "plate", "Y"],
  ["Dabeli", "Street Food", 25, "each", "Y"],
  ["Vadapav", "Street Food", 25, "each", "Y"],
  ["Samosa", "Farsan", 15, "each", "Y"],
];

async function main() {
  const auth = new google.auth.JWT({
    email: cfg.sheets.email, key: cfg.sheets.key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: cfg.sheets.sheetId });
  const existing = meta.data.sheets.map((s) => s.properties.title);

  const requests = Object.keys(TABS)
    .filter((t) => !existing.includes(t))
    .map((t) => ({ addSheet: { properties: { title: t } } }));
  if (requests.length) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: cfg.sheets.sheetId, requestBody: { requests } });
    console.log("Created tabs:", requests.map((r) => r.addSheet.properties.title).join(", "));
  }

  for (const [tab, headers] of Object.entries(TABS)) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: cfg.sheets.sheetId, range: `${tab}!A1`,
      valueInputOption: "USER_ENTERED", requestBody: { values: [headers] },
    });
  }

  const catRows = await sheets.spreadsheets.values.get({ spreadsheetId: cfg.sheets.sheetId, range: "Catalog!A2:E20" });
  if (!(catRows.data.values || []).length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: cfg.sheets.sheetId, range: "Catalog!A2",
      valueInputOption: "USER_ENTERED", requestBody: { values: PLACEHOLDER_CATALOG },
    });
    console.log("Seeded Catalog price book (edit items/prices in the sheet anytime).");
  }

  console.log("✅ Sheet setup complete. Set today's menu from WhatsApp by pasting your daily menu to the bot.");
}

main().catch((e) => { console.error("Setup failed:", e.message); process.exit(1); });
