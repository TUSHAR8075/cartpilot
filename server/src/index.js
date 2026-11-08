import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chat } from "./agent.js";
import { captureOrder, verifyWebhook, CURRENCY } from "./paypal.js";
import { getSession, initDb, saveOrder, findOrder, findOrderByCapture, listOrders } from "./store.js";
import { catalogSource } from "./catalog.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const sessionId = (req) => String(req.body?.sessionId || req.query.sessionId || "anon").slice(0, 64);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/config", (_req, res) =>
  res.json({ paypalClientId: process.env.PAYPAL_CLIENT_ID || "", currency: CURRENCY(), catalog: catalogSource() })
);

app.post("/api/chat", async (req, res) => {
  const text = String(req.body?.message || "").trim();
  if (!text) return res.status(400).json({ error: "message is required" });
  const session = getSession(sessionId(req));
  try {
    const { reply, events } = await chat(session, text);
    res.json({ reply, events, pendingOrderId: session.pendingOrderId });
  } catch (e) {
    console.error("[chat]", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/orders", async (req, res) => res.json(await listOrders(sessionId(req))));

// Called by the PayPal button after the shopper approves.
app.post("/api/orders/:orderId/capture", async (req, res) => {
  const { orderId } = req.params;
  const session = getSession(sessionId(req));
  try {
    const stored = await findOrder(orderId);
    if (!stored || stored.sessionId !== session.id) return res.status(404).json({ error: "Order not found" });
    const data = await captureOrder(orderId);
    const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
    await saveOrder({
      orderId,
      status: data.status,
      captureId: capture?.id,
      payerEmail: data.payer?.email_address,
    });
    if (data.status === "COMPLETED") {
      session.cart = [];
      session.pendingOrderId = null;
      // Let the agent know, so follow-up chat has context.
      session.messages.push(
        { role: "user", content: `[system] Payment captured. Order ${orderId} is COMPLETED (capture ${capture?.id}).` },
        { role: "assistant", content: "Noted: the order is paid." }
      );
    }
    res.json({ status: data.status, captureId: capture?.id, payer: data.payer?.name });
  } catch (e) {
    console.error("[capture]", e.message, e.details || "");
    res.status(e.status || 500).json({ error: e.message, details: e.details });
  }
});

// PayPal webhooks: keeps order state in sync (e.g. refunds done from the PayPal dashboard).
app.post("/api/webhooks/paypal", async (req, res) => {
  try {
    if (!(await verifyWebhook(req.headers, req.body))) return res.sendStatus(400);
    const { event_type, resource } = req.body;
    console.log("[webhook]", event_type, resource?.id);
    if (event_type === "PAYMENT.CAPTURE.COMPLETED") {
      const orderId = resource?.supplementary_data?.related_ids?.order_id;
      if (orderId) await saveOrder({ orderId, status: "COMPLETED", captureId: resource.id });
    }
    if (event_type === "PAYMENT.CAPTURE.REFUNDED") {
      const o = await findOrderByCapture(resource.id);
      if (o) await saveOrder({ orderId: o.orderId, status: "REFUNDED" });
    }
    res.sendStatus(200);
  } catch (e) {
    console.error("[webhook]", e.message);
    res.sendStatus(500);
  }
});

// Serve the built React app in production (single Render web service).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, "../../client/dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(clientDist, "index.html")));
}

const PORT = process.env.PORT || 8080;
initDb()
  .catch((e) => console.error("[store] Mongo connection failed, using memory:", e.message))
  .finally(() => app.listen(PORT, () => console.log(`CartPilot server on http://localhost:${PORT}`)));
