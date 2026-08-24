/**
 * Create / upload / publish the WhatsApp Flow used for ordering.
 *
 *   node scripts/waFlow.js list                 - every Flow on the WABA
 *   node scripts/waFlow.js create               - create a draft Flow (once)
 *   node scripts/waFlow.js upload [FLOW_ID]     - push src/flow/orderFlow.json
 *   node scripts/waFlow.js publish [FLOW_ID]    - publish it (required for real use)
 *   node scripts/waFlow.js preview [FLOW_ID]    - get a browser preview URL
 *   node scripts/waFlow.js send <PHONE>         - send today's menu as the Flow
 *
 * FLOW_ID is remembered in .env as WHATSAPP_FLOW_ID after `create`, so the later
 * commands can be run without it.
 *
 * The Flow carries no endpoint: today's menu is injected in the send call, so
 * there is nothing extra to host and the tunnel setup is untouched.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const GRAPH = "https://graph.facebook.com/v21.0";
const TOKEN = process.env.WHATSAPP_TOKEN;
const WABA = process.env.WHATSAPP_WABA_ID || "1348165230119172";
const FLOW_JSON = path.join(__dirname, "..", "src", "flow", "orderFlow.json");

async function api(pathname, { method = "GET", body, form } = {}) {
  const headers = { Authorization: `Bearer ${TOKEN}` };
  let payload;
  if (form) payload = form;
  else if (body) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(`${GRAPH}/${pathname}`, { method, headers, body: payload });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function report(label, r) {
  if (r.ok) { console.log(`${label}: OK`); console.log(JSON.stringify(r.data, null, 1)); return true; }
  const e = r.data.error || {};
  console.error(`${label}: FAILED (HTTP ${r.status}, code ${e.code}${e.error_subcode ? "/" + e.error_subcode : ""})`);
  console.error("  " + (e.error_user_msg || e.message || JSON.stringify(r.data)));
  // Flow validation errors arrive nested and are the useful part.
  if (e.error_data) console.error("  " + JSON.stringify(e.error_data, null, 1));
  return false;
}

/** Persist the flow id so later commands don't need it passed in. */
function rememberFlowId(id) {
  const envPath = path.join(__dirname, "..", ".env");
  let env = fs.readFileSync(envPath, "utf8");
  if (/^WHATSAPP_FLOW_ID=.*$/m.test(env)) env = env.replace(/^WHATSAPP_FLOW_ID=.*$/m, `WHATSAPP_FLOW_ID=${id}`);
  else env = env.replace(/^(WHATSAPP_VERIFY_TOKEN=.*)$/m, `$1\nWHATSAPP_FLOW_ID=${id}`);
  fs.writeFileSync(envPath, env);
  console.log(`\nSaved WHATSAPP_FLOW_ID=${id} to .env`);
}

const flowId = () => process.argv[3] || process.env.WHATSAPP_FLOW_ID;

async function main() {
  const cmd = process.argv[2];
  if (!TOKEN) return console.error("WHATSAPP_TOKEN missing from .env");

  if (!cmd || cmd === "list") {
    const r = await api(`${WABA}/flows?fields=id,name,status,categories,validation_errors`);
    return void report("list", r);
  }

  if (cmd === "create") {
    const r = await api(`${WABA}/flows`, {
      method: "POST",
      body: { name: "Tiffin daily order", categories: ["OTHER"] },
    });
    if (!report("create", r)) return;
    if (r.data.id) rememberFlowId(r.data.id);
    return;
  }

  if (cmd === "upload") {
    const id = flowId();
    if (!id) return console.error("No flow id. Run `create` first, or pass one.");
    const json = fs.readFileSync(FLOW_JSON);
    const form = new FormData();
    form.append("name", "flow.json");
    form.append("asset_type", "FLOW_JSON");
    form.append("file", new Blob([json], { type: "application/json" }), "flow.json");
    const r = await api(`${id}/assets`, { method: "POST", form });
    return void report("upload", r);
  }

  if (cmd === "publish") {
    const id = flowId();
    if (!id) return console.error("No flow id.");
    return void report("publish", await api(`${id}/publish`, { method: "POST" }));
  }

  if (cmd === "preview") {
    const id = flowId();
    if (!id) return console.error("No flow id.");
    return void report("preview", await api(`${id}?fields=preview.invalidate(false)`));
  }

  if (cmd === "send") {
    const to = process.argv[3];
    if (!to) return console.error("Usage: send <PHONE with country code, digits only>");
    const { sendOrderFlow } = require("../src/flowOrder");
    const sheets = require("../src/sheets");
    const rows = await sheets.getMenu();
    if (!rows || !rows.length) return console.error("No menu set for today — set it from WhatsApp first.");
    const customer = await sheets.getCustomer(to);
    const r = await sendOrderFlow(to, rows, customer?.address || "");
    console.log(r ? "sent" : "send failed — see the log line above");
    return;
  }

  console.error("Unknown command:", cmd);
}

main().catch((e) => { console.error(e); process.exit(1); });
