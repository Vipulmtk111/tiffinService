const cfg = require("./config");

const GRAPH = "https://graph.facebook.com/v21.0";

async function post(body, attempt = 0) {
  try {
    const res = await fetch(`${GRAPH}/${cfg.whatsapp.phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.whatsapp.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`WA ${res.status}: ${JSON.stringify(data)}`);
    return data;
  } catch (err) {
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      return post(body, attempt + 1);
    }
    console.error("[whatsapp] send failed:", err.message);
    return null;
  }
}

/** Send a plain text message. `to` = digits only with country code, e.g. 9198xxxxxx */
async function sendText(to, text) {
  console.log(`[out -> ${to}] ${text.slice(0, 120).replace(/\n/g, " | ")}`);
  return post({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text, preview_url: false },
  });
}

/** Send an approved template (needed outside the 24h window, e.g. daily menu broadcast) */
async function sendTemplate(to, templateName, bodyParams = [], lang = "en") {
  return post({
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: lang },
      components: bodyParams.length
        ? [{ type: "body", parameters: bodyParams.map((t) => ({ type: "text", text: String(t) })) }]
        : [],
    },
  });
}

// ---- Interactive messages (tappable lists & reply buttons) ----
// WhatsApp limits: list = up to 10 sections, 10 rows total; row title ≤24 chars,
// description ≤72; button title ≤20. Reply buttons: up to 3 per message.
const cut = (s, n) => (s == null ? "" : String(s)).slice(0, n);

/**
 * Send a tappable List message.
 * sections = [{ title, rows: [{ id, title, description }] }]
 */
async function sendList(to, { body, header, footer, buttonText = "Select", sections }) {
  const cleanSections = sections
    .map((s) => ({
      title: cut(s.title, 24),
      rows: s.rows.slice(0, 10).map((r) => ({
        id: cut(r.id, 200),
        title: cut(r.title, 24),
        ...(r.description ? { description: cut(r.description, 72) } : {}),
      })),
    }))
    .filter((s) => s.rows.length);
  console.log(`[out -> ${to}] (list) ${cut(body, 60).replace(/\n/g, " | ")}`);
  return post({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      ...(header ? { header: { type: "text", text: cut(header, 60) } } : {}),
      body: { text: cut(body, 1024) },
      ...(footer ? { footer: { text: cut(footer, 60) } } : {}),
      action: { button: cut(buttonText, 20), sections: cleanSections },
    },
  });
}

/**
 * Send up to 3 reply buttons.
 * buttons = [{ id, title }]
 */
async function sendButtons(to, { body, header, footer, buttons }) {
  console.log(`[out -> ${to}] (buttons) ${cut(body, 60).replace(/\n/g, " | ")}`);
  return post({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      ...(header ? { header: { type: "text", text: cut(header, 60) } } : {}),
      body: { text: cut(body, 1024) },
      ...(footer ? { footer: { text: cut(footer, 60) } } : {}),
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: "reply",
          reply: { id: cut(b.id, 256), title: cut(b.title, 20) },
        })),
      },
    },
  });
}

module.exports = { sendText, sendTemplate, sendList, sendButtons };
