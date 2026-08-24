const express = require("express");
const cfg = require("./config");
const { handleMessage, handleFlowOrder } = require("./logic");
const { handleOwner } = require("./ownerCommands");
const { startJobs } = require("./jobs");

const app = express();
app.use(express.json());

const startedAt = new Date();
let lastWebhookAt = null;
const seenIds = new Set(); // webhook dedupe (Meta retries)

app.get("/health", (_req, res) => {
  res.json({ ok: true, uptimeSec: Math.round((Date.now() - startedAt) / 1000), lastWebhookAt });
});

// Meta webhook verification handshake
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === cfg.whatsapp.verifyToken) {
    console.log("[webhook] verified ✅");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Incoming messages
app.post("/webhook", (req, res) => {
  res.sendStatus(200); // ack immediately; process async
  lastWebhookAt = new Date().toISOString();
  try {
    const entries = req.body.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        for (const msg of value.messages || []) {
          if (seenIds.has(msg.id)) continue;
          seenIds.add(msg.id);
          if (seenIds.size > 2000) seenIds.clear();

          const phone = msg.from;
          const contact = (value.contacts || []).find((c) => c.wa_id === phone);
          const name = contact?.profile?.name || "";

          // Extract text OR an interactive selection id (button/list tap).
          let text = "";
          let selectionId = null;
          let flowReply = null;
          if (msg.type === "text") {
            text = msg.text?.body || "";
          } else if (msg.type === "interactive") {
            const ir = msg.interactive || {};
            if (ir.nfm_reply) {
              // A submitted WhatsApp Flow — the whole order in one payload.
              try {
                flowReply = JSON.parse(ir.nfm_reply.response_json || "{}");
              } catch (err) {
                console.error("[flow] bad response_json:", err.message);
              }
            }
            const reply = ir.button_reply || ir.list_reply || {};
            selectionId = reply.id || null;
            text = reply.title || "";
          } else {
            continue; // ignore images/audio/etc. for now
          }
          console.log(`[in <- ${phone} ${name}] ${flowReply ? "[flow] " : ""}${selectionId ? `[tap:${selectionId}] ` : ""}${text}`);

          // A Flow submission is always a customer order, even from the owner's
          // own number while they're testing it.
          const route = flowReply
            ? handleFlowOrder(phone, name, flowReply)
            : phone === cfg.biz.ownerPhone
              ? handleOwner(text, selectionId)
              : handleMessage(phone, name, text, selectionId);
          route.catch((err) => console.error("[handler] error:", err));
        }
        // log delivery failures
        for (const st of value.statuses || []) {
          if (st.status === "failed") console.error("[wa status] delivery failed:", JSON.stringify(st.errors || st));
        }
      }
    }
  } catch (err) {
    console.error("[webhook] parse error:", err);
  }
});

app.listen(cfg.port, () => {
  console.log(`🍱 ${cfg.biz.shopName} bot listening on :${cfg.port}`);
  startJobs();
});

process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));
