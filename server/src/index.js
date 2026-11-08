import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chat } from "./agent.js";
import { captureOrder, verifyWebhook, CURRENCY, createSetupToken, createPaymentToken } from "./paypal.js";
import { getAutopilot, view as autopilotView, log as apLog, revoke, undoPurchase, startWatcher, setLimits, cancelWatch } from "./autopilot.js";
import { getSession, initDb, saveOrder, findOrder, findOrderByCapture, listOrders, persistSessions } from "./store.js";
import { catalogSource, setDemoPrice, demoSimulationEnabled } from "./catalog.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const sessionId = (req) => String(req.body?.sessionId || req.query.sessionId || "anon").slice(0, 64);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/config", (_req, res) =>
  res.json({ paypalClientId: process.env.PAYPAL_CLIENT_ID || "", currency: CURRENCY(), catalog: catalogSource(), demoPrices: demoSimulationEnabled() })
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
      (session.notes ||= []).push(`Payment captured. Order ${orderId} is COMPLETED (capture ${capture?.id}).`);
    }
    res.json({ status: data.status, captureId: capture?.id, payer: data.payer?.name });
  } catch (e) {
    console.error("[capture]", e.message, e.details || "");
    res.status(e.status || 500).json({ error: e.message, details: e.details });
  }
});

// ---------- Autopilot ----------
const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    console.error("[autopilot api]", e.message, e.details ? JSON.stringify(e.details) : "");
    res.status(e.status || 400).json({ error: e.message, details: e.details });
  }
};

app.get("/api/autopilot", wrap(async (req, res) => res.json(autopilotView(getAutopilot(getSession(sessionId(req)))))));

// Step 1: setup token for the PayPal popup (buyer approves saving PayPal; no charge)
app.post("/api/autopilot/setup-token", wrap(async (req, res) => {
  const origin = req.headers.origin || `http://localhost:${process.env.PORT || 8080}`;
  const st = await createSetupToken({ returnUrl: `${origin}/?vault=return`, cancelUrl: `${origin}/?vault=cancel` });
  res.json({ id: st.id });
}));

// Step 2: after approval, exchange for a payment token and store it on the session
app.post("/api/autopilot/connect", wrap(async (req, res) => {
  const session = getSession(sessionId(req));
  const ap = getAutopilot(session);
  const pt = await createPaymentToken(String(req.body.setupTokenId));
  ap.vaultId = pt.id;
  ap.customerId = pt.customer?.id || null;
  ap.payerEmail = pt.payment_source?.paypal?.email_address || null;
  ap.connectedAt = new Date().toISOString();
  ap.watches.filter((w) => w.status === "paused").forEach((w) => (w.status = "watching"));
  apLog(ap, { type: "connect", text: `PayPal connected${ap.payerEmail ? ` (${ap.payerEmail})` : ""}. Autopilot can now buy within your limits.` });
  (session.notes ||= []).push("Shopper connected PayPal for Autopilot.");
  res.json(autopilotView(ap));
}));

app.post("/api/autopilot/revoke", wrap(async (req, res) => {
  const ap = getAutopilot(getSession(sessionId(req)));
  await revoke(ap);
  res.json(autopilotView(ap));
}));

app.post("/api/autopilot/undo/:activityId", wrap(async (req, res) => {
  const session = getSession(sessionId(req));
  const ap = getAutopilot(session);
  await undoPurchase(session, ap, req.params.activityId);
  res.json(autopilotView(ap));
}));

app.post("/api/autopilot/limits", wrap(async (req, res) => {
  const ap = getAutopilot(getSession(sessionId(req)));
  const { per_order_limit, monthly_limit } = req.body;
  for (const v of [per_order_limit, monthly_limit]) {
    if (v != null && !(Number(v) > 0 && Number(v) <= 10000)) throw new Error("Limits must be between $0 and $10,000");
  }
  setLimits(ap, { per_order_limit, monthly_limit });
  persistSessions();
  res.json(autopilotView(ap));
}));

app.post("/api/autopilot/watches/:watchId/cancel", wrap(async (req, res) => {
  const ap = getAutopilot(getSession(sessionId(req)));
  cancelWatch(ap, req.params.watchId);
  persistSessions();
  res.json(autopilotView(ap));
}));

// Dashboard: everything the AG Grid views need in one call
app.get("/api/dashboard", wrap(async (req, res) => {
  const session = getSession(sessionId(req));
  const ap = autopilotView(getAutopilot(session));
  const orders = (await listOrders(session.id)).map((o) => {
    const refundedCents = (o.refunds || []).reduce((s, r) => s + (r.cents || 0), 0);
    return {
      orderId: o.orderId,
      createdAt: o.createdAt,
      source: o.source === "autopilot" ? "autopilot" : "chat",
      items: (o.lines || []).map((l) => `${l.qty}× ${l.title}`).join(", "),
      total: (o.totalCents || 0) / 100,
      refunded: refundedCents / 100,
      status: o.status,
      payer: o.payerEmail || null,
    };
  });
  const paid = orders.filter((o) => ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"].includes(o.status));
  res.json({
    autopilot: ap,
    orders,
    kpis: {
      spentThisMonth: ap.spentThisMonth,
      monthlyLimit: ap.monthlyLimit,
      perOrderLimit: ap.perOrderLimit,
      paidOrders: paid.length,
      grossPaid: Number(paid.reduce((s, o) => s + o.total, 0).toFixed(2)),
      refunded: Number(orders.reduce((s, o) => s + o.refunded, 0).toFixed(2)),
      autopilotBuys: ap.activity.filter((a) => a.type === "purchase").length,
      blocked: ap.activity.filter((a) => a.type === "blocked").length,
      activeWatches: ap.watches.filter((w) => w.status === "watching").length,
      connected: ap.connected,
    },
  });
}));

// Demo helper: simulate a price drop in the built-in demo catalog (disabled when using Channel3)
app.post("/api/demo/price", wrap(async (req, res) => {
  res.json(setDemoPrice(String(req.body.productId), req.body.price));
}));

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
  .finally(() => {
    startWatcher();
    app.listen(PORT, () => console.log(`CartPilot server on http://localhost:${PORT}`));
  });
