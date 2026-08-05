/**
 * WhatsApp Cloud API config checker.
 *
 *   node scripts/waCheck.js              -> checks the token + WHATSAPP_PHONE_NUMBER_ID from .env
 *   node scripts/waCheck.js <WABA_ID>    -> also lists every phone number on that WhatsApp Business
 *                                           Account with its registration status
 *
 * The WABA ID is on Meta dashboard -> WhatsApp -> API Setup, just under the
 * "Phone number ID" (labelled "WhatsApp Business Account ID").
 */
require("dotenv").config();

const GRAPH = "https://graph.facebook.com/v21.0";
const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WABA_ID = process.argv[2];

async function get(path) {
  const res = await fetch(`${GRAPH}/${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return { ok: res.ok, body: await res.json().catch(() => ({})) };
}

(async () => {
  if (!TOKEN) return console.error("WHATSAPP_TOKEN missing from .env");

  // --- token ---
  const tok = await get(`debug_token?input_token=${TOKEN}`);
  const d = tok.body.data || {};
  console.log("TOKEN");
  console.log(`  app        : ${d.application || "?"} (${d.app_id || "?"})`);
  console.log(`  valid      : ${d.is_valid}`);
  console.log(`  expires    : ${d.expires_at ? new Date(d.expires_at * 1000).toISOString() : "never"}`);
  console.log(`  scopes     : ${(d.scopes || []).join(", ")}`);
  if (!(d.scopes || []).includes("whatsapp_business_messaging"))
    console.log("  !! missing whatsapp_business_messaging - sends will fail");

  // --- phone number id ---
  console.log("\nWHATSAPP_PHONE_NUMBER_ID =", PHONE_ID || "(missing)");
  if (PHONE_ID) {
    const fields = "display_phone_number,verified_name,code_verification_status,status,quality_rating,platform_type,name_status";
    const p = await get(`${PHONE_ID}?fields=${fields}`);
    if (!p.ok) {
      console.log("  !! NOT a WhatsApp phone number node:", p.body.error?.message);
      console.log("     Copy the 'Phone number ID' from Meta -> WhatsApp -> API Setup");
      console.log("     (it sits directly under the 'From' number, NOT your Facebook page id).");
    } else {
      const n = p.body;
      console.log(`  number     : ${n.display_phone_number}  (${n.verified_name || "unnamed"})`);
      console.log(`  status     : ${n.status}            <- must be CONNECTED to receive messages`);
      console.log(`  verified   : ${n.code_verification_status}`);
      console.log(`  platform   : ${n.platform_type}`);
      console.log(`  quality    : ${n.quality_rating}`);
      if (n.status !== "CONNECTED")
        console.log("  !! not CONNECTED - the number is not live on WhatsApp yet, so users see\n" +
                    "     'not on WhatsApp / invite'. Finish registration (6-digit PIN) in API Setup.");
    }
  }

  // --- all numbers on the WABA ---
  if (WABA_ID) {
    const list = await get(`${WABA_ID}/phone_numbers?fields=id,display_phone_number,verified_name,status,code_verification_status,platform_type`);
    console.log("\nNUMBERS ON WABA", WABA_ID);
    if (!list.ok) console.log("  error:", list.body.error?.message);
    else for (const n of list.body.data || [])
      console.log(`  ${n.display_phone_number}  id=${n.id}  status=${n.status}  verified=${n.code_verification_status}  platform=${n.platform_type}`);
  } else {
    console.log("\nTip: pass your WhatsApp Business Account ID to list every number and its real\n" +
                "phone number id:  node scripts/waCheck.js <WABA_ID>");
  }
})();
