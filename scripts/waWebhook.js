/**
 * Read / set / clear the per-phone-number webhook override.
 *
 *   node scripts/waWebhook.js show
 *   node scripts/waWebhook.js set https://<something>.trycloudflare.com
 *   node scripts/waWebhook.js clear
 *
 * A phone-number-level override BEATS the app-level webhook on the Meta
 * Configuration page. If one is set and points at a dead URL, changing the
 * dashboard URL does nothing - inbound messages keep going to the dead host.
 *
 * `set` appends /webhook for you and uses WHATSAPP_VERIFY_TOKEN from .env, so
 * Meta's verification handshake hits the GET /webhook route in src/index.js.
 * `clear` removes the override so the app-level webhook applies again.
 *
 * Uses WHATSAPP_PHONE_NUMBER_ID from .env - make sure it is the real one.
 */
require("dotenv").config();

const GRAPH = "https://graph.facebook.com/v21.0";
const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const VERIFY = process.env.WHATSAPP_VERIFY_TOKEN || "tiffin-bot-verify-123";

async function call(path, method = "GET", body) {
  const res = await fetch(`${GRAPH}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}

async function show() {
  const r = await call(`${PHONE_ID}?fields=display_phone_number,status,webhook_configuration`);
  if (!r.ok) return console.error("FAILED:", r.data.error?.message), null;
  const uri = r.data.webhook_configuration?.application || null;
  console.log(`number   : ${r.data.display_phone_number}  (${r.data.status})`);
  console.log(`override : ${uri || "(none - the app-level webhook applies)"}`);
  return uri;
}

/** Reachability check, so a typo or dead tunnel is caught immediately. */
async function probe(base) {
  const url = `${base}/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY)}&hub.challenge=ping`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const body = (await res.text()).trim();
    if (res.ok && body === "ping") return console.log("probe    : OK - handshake answered correctly"), true;
    console.log(`probe    : reachable but handshake failed (HTTP ${res.status}, body "${body.slice(0, 40)}")`);
    console.log("           WHATSAPP_VERIFY_TOKEN here must match the one on the server.");
    return false;
  } catch (e) {
    console.log(`probe    : UNREACHABLE (${e.message})`);
    console.log("           Is the tunnel window still open? Quick-tunnel URLs change on every restart.");
    return false;
  }
}

(async () => {
  const [cmd, arg] = process.argv.slice(2);
  if (!TOKEN || !PHONE_ID) return console.error("WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID missing from .env");

  if (!cmd || cmd === "show") return void (await show());

  if (cmd === "set") {
    if (!/^https:\/\/\S+$/.test(arg || "")) return console.error("Usage: set https://<host>  (no trailing /webhook)");
    const base = arg.replace(/\/+$/, "").replace(/\/webhook$/, "");
    await probe(base);
    const payload = { override_callback_uri: `${base}/webhook`, verify_token: VERIFY };
    // Meta has shipped two shapes for this; try the documented one, then the fallback.
    let r = await call(`${PHONE_ID}/webhook_configuration`, "POST", payload);
    if (!r.ok) r = await call(`${PHONE_ID}`, "POST", { webhook_configuration: payload });
    if (!r.ok) {
      console.error("FAILED:", r.data.error?.message || JSON.stringify(r.data));
      console.error("Fall back to the dashboard: Meta -> WhatsApp -> Configuration -> Edit.");
      return;
    }
    console.log("set OK\n");
    await show();
    return;
  }

  if (cmd === "clear") {
    let r = await call(`${PHONE_ID}/webhook_configuration`, "DELETE");
    if (!r.ok) r = await call(`${PHONE_ID}`, "POST", { webhook_configuration: { override_callback_uri: "" } });
    if (!r.ok) return console.error("FAILED:", r.data.error?.message || JSON.stringify(r.data));
    console.log("cleared - the app-level webhook now applies\n");
    await show();
    return;
  }

  console.error("Unknown command:", cmd, "- use show | set <url> | clear");
})();
