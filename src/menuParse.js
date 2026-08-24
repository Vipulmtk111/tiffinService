/**
 * Deterministic daily-menu parser + sheet encoding. No LLM, no network.
 *
 * AGREED OWNER FORMAT
 * -------------------
 *   TIFFIN - 80
 *
 *   SABJI (any 1)
 *   - Suki Bhaji
 *   - Sev Tameta
 *
 *   BREAD (any 1)
 *   - Roti x5
 *   - Thepla x4
 *
 *   INCLUDED
 *   - Dal Bhat
 *   - Fryms
 *
 *   EXTRA
 *   - Dhokla - 40
 *   - Samosa - 15
 *
 * Rules:
 *   "TIFFIN - 80"     today's tiffin price (optional; falls back to TIFFIN_PRICE)
 *   "<NAME> (any 1)"  a choose-one group; the customer picks exactly one option
 *   "INCLUDED"        always in the tiffin, shown but never asked about
 *   "EXTRA"           a la carte items, each with its own price
 *   "Roti x5"         x5 / [5] / (5) is the QUANTITY included, never a price
 *   "Dhokla - 40"     inside EXTRA, a trailing number is the PRICE
 *
 * The owner's decoration survives: 》 ● 👉 * • and "1." numbering are stripped.
 * A paste with no section headers at all is read as a flat priced list and
 * treated as EXTRA items, so the older "Flower bateta - 50" style still works.
 */

// Section header shapes. A choose-one header just has to say "any"/"select"/
// "choose"/"koi" and carry no price, so both "SABJI (any 1)" and the owner's
// older "》SABJI..Select any" / "》Select Any" are recognised.
const RE_CHOICE_WORDS = /\b(select|choose|any|koi)\b/i;
const RE_INCLUDED = /^(included|include|with\s*every\s*tiffin|saath\s*mein|always|fixed)\b/i;
const RE_EXTRA = /^(extra|extras|snacks?|add[-\s]?ons?|farsan)\b/i;
const RE_TIFFIN_PRICE = /^tiffin\s*[-–—:=]?\s*(?:₹|rs\.?|inr)?\s*(\d{1,4})\s*(?:\/-)?$/i;
// Shop chatter that must never become an item.
const RE_NOISE = /\b(book|booking|ping|call|contact|whatsapp|number|stock|delivery|timing|before|after|thanks|regards|order\s*(now|before))\b/i;
const RE_TIME = /\d{1,2}\s*[:.]\s*\d{2}\s*(am|pm)?/i;

const MAX_PRICE = 5000;

/** Strip the owner's decoration: 》 ● 👉 bullets, numbering, emoji, stray punctuation. */
function clean(s) {
  return String(s)
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}\u{3000}-\u{303F}]/gu, " ")
    .replace(/^[\s\-*•·>》●○◆■▶👉#~_.)\]]+/u, "")
    .replace(/[\s\-*•·》●○◆■~_]+$/u, "")
    .replace(/^\d+\s*[.)]\s*/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Title Case, preserving an existing mixed-case word like "McDonald". */
function titleCase(s) {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** "Roti x5" | "Roti [5]" | "Roti (5)" -> { name:"Roti", qty:5 } */
function splitQty(s) {
  const m = s.match(/^(.+?)\s*(?:x\s*(\d{1,3})|[\[(]\s*(\d{1,3})\s*[\])])\s*$/i);
  if (!m) return { name: s, qty: null };
  const qty = Number(m[2] || m[3]);
  const name = m[1].trim();
  if (!name || !Number.isFinite(qty) || qty < 1 || qty > 100) return { name: s, qty: null };
  return { name, qty };
}

/** "Dhokla - 40" | "Dhokla 40" | "Dhokla Rs.40" -> { name:"Dhokla", price:40 } */
function splitPrice(s) {
  const patterns = [
    /^(.+?)\s*[-–—:=@]+\s*(?:₹|rs\.?|inr)?\s*(\d{1,4}(?:\.\d{1,2})?)\s*(?:\/-|rs\.?|₹)?\s*$/i,
    /^(.+?)\s+(?:₹|rs\.?|inr)\s*(\d{1,4}(?:\.\d{1,2})?)\s*(?:\/-)?\s*$/i,
    /^(.+?)\s+(\d{1,4}(?:\.\d{1,2})?)\s*(?:\/-|rs\.?|₹)?\s*$/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (!m) continue;
    const price = Number(m[2]);
    const name = m[1].trim();
    if (!name || !/[a-z]/i.test(name)) continue;
    if (!Number.isFinite(price) || price <= 0 || price > MAX_PRICE) continue;
    return { name, price };
  }
  return null;
}

/** Item name tidy-up: "DAL - BHAT" -> "Dal Bhat". */
function itemName(s) {
  return titleCase(String(s).replace(/\s*[-–—]\s*/g, " ").replace(/\s{2,}/g, " ").trim());
}

/** A bare line with no section is only believable as an item if it's short. */
function looksLikeItem(line) {
  return line.length <= 40 && line.split(/\s+/).length <= 5;
}

/**
 * Parse the owner's paste.
 * Returns { tiffinPrice:number|null, groups:[{name, options:[{name, qty}]}],
 *           included:[{name, qty}], extras:[{name, price}], ignored:number }
 */
function parseMenuText(text) {
  const groups = [];
  const included = [];
  const extras = [];
  let tiffinPrice = null;
  let ignored = 0;
  let section = null; // {type:'choice',group} | {type:'included'} | {type:'extra'}
  let filled = 0;     // items collected into the current section
  let sawHeader = false;

  const closeSection = () => { section = null; filled = 0; };

  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = clean(raw);

    // A blank line ends a section that already has items. This is what keeps
    // "● DAL - BHAT●" (after the ROTI/THEPLA block) out of the choice group.
    if (!line || !/[a-z]/i.test(line)) {
      if (filled) closeSection();
      continue;
    }

    // --- price line for the tiffin itself ---
    const tp = line.match(RE_TIFFIN_PRICE);
    if (tp) { tiffinPrice = Number(tp[1]); continue; }

    // --- section headers ---
    if (RE_INCLUDED.test(line)) { section = { type: "included" }; filled = 0; sawHeader = true; continue; }
    if (RE_EXTRA.test(line)) { section = { type: "extra" }; filled = 0; sawHeader = true; continue; }
    if (RE_CHOICE_WORDS.test(line) && !splitPrice(line)) {
      // "SABJI (any 1)" / "SABJI..Select any" / "Select Any"
      const label = itemName(line
        .replace(/\([^)]*\)/g, " ")
        .replace(/\[[^\]]*\]/g, " ")
        .replace(/\b(select|choose|any|one|koi|ek|1)\b/gi, " ")
        .replace(/[.:]+/g, " "));
      const group = { name: label, options: [] };
      groups.push(group);
      section = { type: "choice", group };
      filled = 0;
      sawHeader = true;
      continue;
    }

    if (RE_NOISE.test(line) || RE_TIME.test(line)) { ignored++; continue; }

    // --- item lines ---
    if (!section) {
      const p = splitPrice(line);
      if (p) { extras.push({ name: itemName(p.name), price: p.price }); continue; }
      // Unpriced and section-less: only an item once the paste has proven it is a
      // tiffin menu (a choice group was seen). Otherwise it is decoration.
      if (groups.length && looksLikeItem(line)) {
        const { name, qty } = splitQty(line);
        included.push({ name: itemName(name), qty });
        continue;
      }
      ignored++;
      continue;
    }

    if (section.type === "extra") {
      const p = splitPrice(line);
      if (p) extras.push({ name: itemName(p.name), price: p.price });
      else extras.push({ name: itemName(splitQty(line).name), price: null });
      filled++;
      continue;
    }

    const { name, qty } = splitQty(line);
    const entry = { name: itemName(name), qty };
    if (section.type === "choice") section.group.options.push(entry);
    else included.push(entry);
    filled++;
  }

  // A choice group with one option isn't a choice; with none it's a stray header.
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i].options.length === 1) included.unshift(...groups.splice(i, 1)[0].options);
    else if (groups[i].options.length === 0) groups.splice(i, 1);
  }
  // Unnamed group ("》Select Any") -> name it after its own options.
  for (const g of groups) {
    if (!g.name) g.name = g.options.slice(0, 2).map((o) => o.name).join("/").slice(0, 24);
  }

  return { tiffinPrice, groups, included, extras, ignored, sawHeader };
}

/** True when the paste describes a tiffin (choices/included), not just a price list. */
function isTiffinMenu(m) { return m.groups.length > 0 || m.included.length > 0; }

/** Any orderable content at all? */
function hasContent(m) { return isTiffinMenu(m) || m.extras.length > 0; }

// ---------- Menu sheet encoding ----------
// The Menu tab stays 5 columns (Date|Name|Category|Price|Available). The role of
// each row lives in Category, so no schema migration is needed:
//   base        the tiffin itself, Price = today's tiffin price
//   pick:<Grp>  one option of choose-one group <Grp>
//   incl        always included
//   extra       a la carte item, Price = its own price
const CAT = { base: "base", incl: "incl", extra: "extra", pick: (g) => `pick:${g}` };

/** Model -> rows for sheets.setMenuItems(). Row order is preserved on read. */
function toSheetRows(m, fallbackPrice) {
  const rows = [];
  const price = m.tiffinPrice != null ? m.tiffinPrice : fallbackPrice;
  if (isTiffinMenu(m)) rows.push({ name: "Tiffin", category: CAT.base, price });
  for (const g of m.groups)
    for (const o of g.options)
      rows.push({ name: o.qty ? `${o.name} x${o.qty}` : o.name, category: CAT.pick(g.name), price: 0 });
  for (const i of m.included)
    rows.push({ name: i.qty ? `${i.name} x${i.qty}` : i.name, category: CAT.incl, price: 0 });
  for (const e of m.extras)
    rows.push({ name: e.name, category: CAT.extra, price: e.price ?? 0 });
  return rows;
}

/** Rows from sheets.getMenu() -> the same model shape. */
function fromSheetRows(rows = []) {
  const m = { tiffinPrice: null, groups: [], included: [], extras: [], ignored: 0, sawHeader: true };
  const byGroup = new Map();
  for (const r of rows) {
    const cat = String(r.category || "");
    if (cat === CAT.base) { m.tiffinPrice = Number(r.price) || null; continue; }
    if (cat === CAT.incl) { m.included.push(splitQty(r.name)); continue; }
    if (cat === CAT.extra) { m.extras.push({ name: r.name, price: Number(r.price) || 0 }); continue; }
    if (cat.startsWith("pick:")) {
      const g = cat.slice(5);
      if (!byGroup.has(g)) { const grp = { name: g, options: [] }; byGroup.set(g, grp); m.groups.push(grp); }
      byGroup.get(g).options.push(splitQty(r.name));
      continue;
    }
    // Unknown category (menu set before this format existed) -> treat as extra.
    m.extras.push({ name: r.name, price: Number(r.price) || 0 });
  }
  return m;
}

/** "5 Roti" reads better than "Roti x5" for anything a customer sees. */
function optDisplay(o) { return o.qty ? `${o.qty} ${o.name}` : o.name; }

/** "Suki Bhaji + 5 Roti" — the label on an order line and the confirm card. */
function comboLabel(picks) {
  return picks.map(optDisplay).join(" + ");
}

module.exports = {
  parseMenuText, isTiffinMenu, hasContent,
  toSheetRows, fromSheetRows, comboLabel, optDisplay, splitQty, CAT,
};
