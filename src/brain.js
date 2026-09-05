const cfg = require("./config");

async function chatCompletion(baseUrl, apiKey, model, messages) {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 400 }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const err = new Error(`LLM ${res.status}: ${t.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

/**
 * Parse the OWNER's pasted daily menu (free text like the WhatsApp samples) into
 * structured items. catalog = [{name, category, price}] known price book.
 * Returns { items:[{name, category, price|null}], needPrice:[names] }.
 * Prices come from the catalog when an item matches; unknown items get price=null.
 */
async function parseMenu(text, catalog = []) {
  const catLines = catalog.map((c) => `${c.name} | ${c.category} | ₹${c.price}`).join("\n") || "(empty)";
  const system = `You extract orderable food items from an Indian tiffin/snacks shop's daily menu message (Hindi/English/Hinglish, lots of emojis and decoration).
Return ONLY a strict JSON array, no markdown:
[{"name":"<clean item name, Title Case>","category":"<short category>","price":<number or null>}]
Rules:
- Include every distinct orderable dish/snack/thali. One entry per item.
- IGNORE decoration, headers, section titles, phone/booking lines ("book before 4:30", "ping me", "select any", "full stock").
- If a "thali/meal" has choices (e.g. "Sabji: Bhindi / Dahi Tikhari"), output each choice as its own item named like "Bhindi Thali", "Dahi Tikhari Thali".
- Match names to the KNOWN ITEMS list below and copy their exact name, category and price when it's clearly the same item. For items not in the list, set price to null and pick a sensible short category.
- Numbers in brackets like "Roti [5]" usually mean price; use them as price if plausible.
KNOWN ITEMS (name | category | price):
${catLines}`;

  const providers = [
    { base: cfg.llm.baseUrl, key: cfg.llm.apiKey, model: cfg.llm.model, name: "primary" },
    { base: cfg.llm.fbBaseUrl, key: cfg.llm.fbApiKey, model: cfg.llm.fbModel, name: "fallback" },
  ].filter((p) => p.base && p.key && p.model);

  let items = null;
  for (const p of providers) {
    try {
      const raw = await chatCompletion(p.base, p.key, p.model, [
        { role: "system", content: system },
        { role: "user", content: text },
      ]);
      const m = raw.match(/\[[\s\S]*\]/);
      if (m) { const arr = JSON.parse(m[0]); if (Array.isArray(arr)) { items = arr; break; } }
    } catch (err) {
      console.warn(`[parseMenu] ${p.name} failed: ${err.message}`);
    }
  }
  if (!items) return { items: [], needPrice: [] };

  // Fill prices from catalog for any the model left null; normalize.
  const byName = new Map(catalog.map((c) => [c.name.trim().toLowerCase(), c]));
  const out = [];
  const needPrice = [];
  for (const it of items) {
    const name = String(it.name || "").trim();
    if (!name) continue;
    const known = byName.get(name.toLowerCase());
    let price = it.price != null && it.price !== "" ? Number(it.price) : null;
    let category = it.category || known?.category || "Other";
    if ((price == null || Number.isNaN(price)) && known) price = known.price;
    if (price == null || Number.isNaN(price)) { price = null; needPrice.push(name); }
    out.push({ name, category, price });
  }
  return { items: out, needPrice };
}

/** Free-form generation for owner Q&A (no JSON constraint). Returns null on failure. */
async function freeform(prompt) {
  const providers = [
    { base: cfg.llm.baseUrl, key: cfg.llm.apiKey, model: cfg.llm.model },
    { base: cfg.llm.fbBaseUrl, key: cfg.llm.fbApiKey, model: cfg.llm.fbModel },
  ].filter((p) => p.base && p.key && p.model);
  for (const p of providers) {
    try {
      return await chatCompletion(p.base, p.key, p.model, [
        { role: "system", content: "You are a concise assistant for a tiffin shop owner. Answer briefly in English." },
        { role: "user", content: prompt },
      ]);
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Answer a customer's free-form question as the shop's WhatsApp assistant.
 * facts = { shopName, menu:{sabjiA,sabjiB}, snacks:[{item,price}], tiffinPrice,
 *           includedRotis, extraRotiPrice, orderCutoff, deliveryNote }
 * Returns a customer-ready reply string, or the sentinel "FORWARD" when the
 * question needs the owner (bulk/catering, complaints, custom/refund requests,
 * or anything not answerable from the facts). Returns "FORWARD" on LLM failure
 * so nothing is silently dropped.
 * PRIVACY: never pass phone numbers or addresses into this context.
 */
async function customerAnswer(question, facts) {
  const menuLine = (facts.snacks || []).map((s) => `${s.item} ₹${s.price}`).join(", ") || "not set yet";
  const system = `You are the friendly WhatsApp assistant for "${facts.shopName}", an Indian tiffin & snacks home-kitchen. ` +
    `Answer the customer's question in ONE or TWO short lines, in English. Warm, casual, use an emoji or two.\n` +
    `Use ONLY these facts — never invent items, prices, or promises:\n` +
    `- Today's menu (item ₹price): ${menuLine}\n` +
    `- Order cutoff for today: ${facts.orderCutoff}. Delivery: ${facts.deliveryNote}, free.\n` +
    `- To place an order the customer just types "menu" and taps the items — tell them that.\n` +
    `If the question needs the owner (bulk/party/catering orders, complaints, refunds, custom dishes, ingredient/allergy details you don't have, or anything not in the facts), reply with EXACTLY the single word: FORWARD (nothing else). ` +
    `Do NOT guess about allergies, jain/no-onion-garlic, or health/diet claims — those go to FORWARD.`;
  const ans = await freeform(`${system}\n\nCustomer asks: "${question}"`);
  const clean = (ans || "").trim();
  if (!clean) return "FORWARD";
  // Guard: some free models are content-safety classifiers or leak chain-of-thought.
  // Never let those reach a customer — defer to the owner instead.
  if (/^\s*(user\s+safety|safe|unsafe|flagged)\b/i.test(clean)) return "FORWARD";
  if (/^\s*(we need to|the user asks|let me|i should|as an ai|reasoning:)/i.test(clean)) return "FORWARD";
  return clean;
}

module.exports = { parseMenu, freeform, customerAnswer };
