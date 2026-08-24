/**
 * WhatsApp Flow ordering: one screen, radio groups for sabji/bread, real
 * checkboxes for extras, quantity and address — all submitted together.
 *
 * The Flow itself is static (src/flow/orderFlow.json); today's menu is injected
 * in the send call, so there is no endpoint to host. The customer's answers come
 * back on the webhook as interactive.nfm_reply.response_json.
 *
 * WHATSAPP_FLOW_ID       the published (or draft) Flow, set by scripts/waFlow.js
 * WHATSAPP_FLOW_MODE     "draft" while the Flow is unpublished — a draft Flow
 *                        only opens for people with a role on the WABA, which is
 *                        how the owner can test before business verification.
 */
const cfg = require("./config");
const menuParse = require("./menuParse");

const GRAPH = "https://graph.facebook.com/v21.0";
const MAX_QTY = 5;

const flowId = () => process.env.WHATSAPP_FLOW_ID || "";
const flowMode = () => (process.env.WHATSAPP_FLOW_MODE || "published").toLowerCase();

/** Is the Flow path configured at all? */
function flowEnabled() { return !!flowId(); }

/** Menu model -> the data the Flow screen renders. */
function buildFlowData(m, address = "") {
  const price = m.tiffinPrice != null ? m.tiffinPrice : cfg.biz.tiffinPrice;
  const opts = (list) => list.map((o, i) => ({ id: String(i), title: menuParse.optDisplay(o), description: "" }));

  const incl = m.included.length ? ` · Saath mein: ${m.included.map(menuParse.optDisplay).join(", ")}` : "";
  const [sabji, bread] = m.groups;

  return {
    heading: `Tiffin ₹${price}${incl}`,
    sabji_label: sabji ? `${sabji.name} (koi 1 chunein)` : "Tiffin",
    sabji_options: sabji ? opts(sabji.options) : [{ id: "0", title: "Tiffin", description: `₹${price}` }],
    bread_visible: !!bread,
    bread_label: bread ? `${bread.name} (koi 1)` : "—",
    // A hidden RadioButtonsGroup still needs a non-empty data-source.
    bread_options: bread ? opts(bread.options) : [{ id: "0", title: "—", description: "" }],
    extras_visible: m.extras.length > 0,
    extra_options: m.extras.length
      ? m.extras.map((e, i) => ({ id: String(i), title: e.name, description: `₹${e.price}` }))
      : [{ id: "0", title: "—", description: "" }],
    qty_options: Array.from({ length: MAX_QTY }, (_, i) => ({ id: String(i + 1), title: String(i + 1) })),
    address: address || "",
  };
}

/**
 * Send today's menu as the Flow. Returns the API response, or null on failure so
 * the caller can fall back to the button/list flow.
 */
async function sendOrderFlow(to, rows, address = "") {
  const id = flowId();
  if (!id) return null;
  const m = menuParse.fromSheetRows(rows || []);
  if (!menuParse.isTiffinMenu(m)) return null; // extras-only day: list path is fine

  const price = m.tiffinPrice != null ? m.tiffinPrice : cfg.biz.tiffinPrice;
  const body = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "flow",
      header: { type: "text", text: "Aaj ka menu 🍱" },
      body: { text: `🍱 *${cfg.biz.shopName}*\nTiffin ₹${price}\n\nEk hi form mein apna order bhej dein — sabji, roti, extra aur address.` },
      footer: { text: "Order cutoff: " + cfg.biz.orderCutoff },
      action: {
        name: "flow",
        parameters: {
          flow_message_version: "3",
          flow_token: `order-${to}-${rows.length}`,
          flow_id: id,
          flow_cta: "Order karein 🍱",
          flow_action: "navigate",
          ...(flowMode() === "draft" ? { mode: "draft" } : {}),
          flow_action_payload: { screen: "ORDER", data: buildFlowData(m, address) },
        },
      },
    },
  };

  try {
    const res = await fetch(`${GRAPH}/${cfg.whatsapp.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.whatsapp.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`WA ${res.status}: ${JSON.stringify(data)}`);
    console.log(`[out -> ${to}] (flow ${id}${flowMode() === "draft" ? " draft" : ""})`);
    return data;
  } catch (err) {
    console.error("[flow] send failed:", err.message);
    return null;
  }
}

/**
 * Turn the Flow's submitted answers into cart lines.
 * response = the parsed nfm_reply.response_json.
 * Returns { items:[{name,price,qty}], address } or null if it can't be read.
 */
function parseFlowReply(response, rows) {
  if (!response || typeof response !== "object") return null;
  const m = menuParse.fromSheetRows(rows || []);
  const price = m.tiffinPrice != null ? m.tiffinPrice : cfg.biz.tiffinPrice;
  const [sabjiGroup, breadGroup] = m.groups;

  const pickAt = (group, raw) => {
    if (!group) return null;
    const i = Number(raw);
    return Number.isInteger(i) ? group.options[i] || null : null;
  };

  const picks = [];
  const sabji = pickAt(sabjiGroup, response.sabji);
  if (sabji) picks.push(sabji);
  const bread = pickAt(breadGroup, response.bread);
  if (bread) picks.push(bread);

  const qty = Math.min(Math.max(parseInt(response.qty, 10) || 1, 1), 99);
  const items = [];
  if (sabjiGroup || m.included.length) {
    items.push({
      name: picks.length ? `Tiffin (${menuParse.comboLabel(picks)})` : "Tiffin",
      price,
      qty,
    });
  }

  // CheckboxGroup returns an array of ids; some clients deliver it JSON-encoded.
  let chosen = response.extras;
  if (typeof chosen === "string") {
    try { chosen = JSON.parse(chosen); } catch { chosen = chosen ? [chosen] : []; }
  }
  for (const raw of Array.isArray(chosen) ? chosen : []) {
    const e = m.extras[Number(raw)];
    if (e) items.push({ name: e.name, price: e.price, qty: 1 });
  }

  if (!items.length) return null;
  return { items, address: String(response.address || "").trim() };
}

module.exports = { flowEnabled, buildFlowData, sendOrderFlow, parseFlowReply };
