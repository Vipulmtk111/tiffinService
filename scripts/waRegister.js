/**
 * Register a WhatsApp Cloud API phone number (status Pending -> Connected).
 *
 *   node scripts/waRegister.js status       <PHONE_ID>
 *   node scripts/waRegister.js request-code <PHONE_ID> [SMS|VOICE]
 *   node scripts/waRegister.js verify-code  <PHONE_ID> <CODE>
 *   node scripts/waRegister.js register     <PHONE_ID> <6-DIGIT-PIN>
 *
 * Normal path for a Pending number that is already VERIFIED:
 *   node scripts/waRegister.js register 123456789012345 482913
 *
 * PHONE_ID is the "Phone number ID" from Meta -> WhatsApp -> API Setup
 * (find it with: node scripts/waCheck.js <WABA_ID>).
 * The PIN is yours to choose - any 6 digits. WRITE IT DOWN; Meta asks for it
 * on every future re-registration and there is no way to look it up.
 */
require("dotenv").config();

const GRAPH = "https://graph.facebook.com/v21.0";
const TOKEN = process.env.WHATSAPP_TOKEN;

// Meta error codes that show up during registration, in plain English.
const HINTS = {
  133005: "PIN mismatch. This number already has a two-step PIN from an earlier registration.\n" +
          "  Use that PIN, or reset it in WhatsApp Manager -> the number -> Two-step verification.",
  133006: "Number not verified yet. Run request-code, then verify-code, then register again.",
  133008: "Too many PIN attempts. Wait for the cooldown Meta states, then retry.",
  133010: "Number not registered/verified in this WhatsApp Business Account.",
  133016: "Rate limited or the number was recently deleted. Meta enforces a wait - retry later.",
  133015: "Number is still attached to another account. Delete the WhatsApp/WhatsApp Business\n" +
          "  app account on the SIM (Settings -> Account -> Delete my account), then retry.",
  100:    "Bad phone number ID. Copy the real one from Meta -> WhatsApp -> API Setup.",
};

async function call(path, body) {
  const res = await fetch(`${GRAPH}/${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function report(r) {
  if (r.ok) {
    console.log("OK ->", JSON.stringify(r.data));
    return true;
  }
  const e = r.data.error || {};
  console.error(`FAILED (HTTP ${r.status}, code ${e.code}${e.error_subcode ? "/" + e.error_subcode : ""})`);
  console.error("  " + (e.error_user_msg || e.message || JSON.stringify(r.data)));
  if (HINTS[e.code]) console.error("  " + HINTS[e.code]);
  return false;
}

(async () => {
  const [cmd, phoneId, arg] = process.argv.slice(2);
  if (!TOKEN) return console.error("WHATSAPP_TOKEN missing from .env");
  if (!cmd || !phoneId) {
    console.log(require("fs").readFileSync(__filename, "utf8").split("*/")[0].replace(/^\/\*\*|^ \* ?/gm, ""));
    process.exit(1);
  }

  if (cmd === "status") {
    const r = await call(`${phoneId}?fields=display_phone_number,verified_name,status,code_verification_status,platform_type,quality_rating`);
    if (!report(r)) return;
    if (r.data.status !== "CONNECTED")
      console.log("\nNot CONNECTED yet - the number is invisible on WhatsApp until it is.");
    return;
  }

  if (cmd === "request-code") {
    console.log(`Requesting a verification code by ${arg || "SMS"} ...`);
    return void report(await call(`${phoneId}/request_code`, { code_method: (arg || "SMS").toUpperCase(), language: "en" }));
  }

  if (cmd === "verify-code") {
    if (!arg) return console.error("Pass the code you received: verify-code <PHONE_ID> <CODE>");
    return void report(await call(`${phoneId}/verify_code`, { code: String(arg) }));
  }

  if (cmd === "register") {
    if (!/^\d{6}$/.test(arg || "")) return console.error("Pass a 6-digit PIN: register <PHONE_ID> <PIN>");
    console.log("Registering the number on WhatsApp ...");
    if (!report(await call(`${phoneId}/register`, { messaging_product: "whatsapp", pin: String(arg) }))) return;
    const s = await call(`${phoneId}?fields=display_phone_number,status`);
    console.log("Now:", JSON.stringify(s.data));
    console.log("\nWhen status is CONNECTED, the number is live on WhatsApp - message it from\n" +
                "another phone via https://wa.me/<number-without-plus> and watch the bot window.");
    return;
  }

  console.error("Unknown command:", cmd);
})();
