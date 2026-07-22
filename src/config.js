require("dotenv").config();

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

module.exports = {
  whatsapp: {
    token: process.env.WHATSAPP_TOKEN,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || "tiffin-bot-verify-123",
  },
  llm: {
    baseUrl: process.env.LLM_BASE_URL,
    apiKey: process.env.LLM_API_KEY,
    model: process.env.LLM_MODEL,
    fbBaseUrl: process.env.FALLBACK_LLM_BASE_URL,
    fbApiKey: process.env.FALLBACK_LLM_API_KEY,
    fbModel: process.env.FALLBACK_LLM_MODEL,
  },
  sheets: {
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    sheetId: process.env.SHEET_ID,
  },
  biz: {
    shopName: process.env.SHOP_NAME || "Tiffin Shop",
    ownerPhone: (process.env.OWNER_PHONE || "").replace(/\D/g, ""),
    tiffinPrice: num(process.env.TIFFIN_PRICE, 80),
    includedRotis: num(process.env.INCLUDED_ROTIS, 4),
    extraRotiPrice: num(process.env.EXTRA_ROTI_PRICE, 8),
    orderCutoff: process.env.ORDER_CUTOFF || "12:00",
    menuReminderTime: process.env.MENU_REMINDER_TIME || "08:00",
    menuTime: process.env.MENU_BROADCAST_TIME || "10:30",
    paymentTime: process.env.PAYMENT_MESSAGE_TIME || "19:30",
    reminderTime: process.env.REMINDER_TIME || "10:00",
    summaryTime: process.env.SUMMARY_TIME || "21:00",
    upiId: process.env.UPI_ID || "",
    radiusNote: process.env.DELIVERY_RADIUS_NOTE || "3km",
    tz: process.env.TZ || "Asia/Kolkata",
  },
  port: num(process.env.PORT, 3000),
};
