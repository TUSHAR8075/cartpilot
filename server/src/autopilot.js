// CartPilot Autopilot: the agent buys for the shopper while they're away,
// using a PayPal-vaulted payment method, strictly inside shopper-set spending rules.
import { getProduct, getCurrentPrice } from "./catalog.js";
import { chargeVaulted, refundCapture, deletePaymentToken } from "./paypal.js";
import { allSessions, saveOrder } from "./store.js";

const dollars = (c) => Number((c / 100).toFixed(2));
const cents = (n) => Math.round(Number(n) * 100);

export function getAutopilot(session) {
  if (!session.autopilot) {
    session.autopilot = {
      vaultId: null,
      customerId: null,
      payerEmail: null,
      connectedAt: null,
      perOrderLimitCents: 5000, // $50 default
      monthlyLimitCents: 10000, // $100 default
      watches: [], // {id, productId, title, targetCents, qty, status, createdAt, lastPrice}
      activity: [], // {id, type, at, text, orderId?, captureId?, amountCents?, undone?}
    };
  }
  return session.autopilot;
}

export function log(ap, entry) {
  console.log(`[autopilot] ${entry.type}: ${entry.text}`);
  ap.activity.unshift({ id: `a_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, at: new Date().toISOString(), ...entry });
  ap.activity = ap.activity.slice(0, 100);
}

export function monthSpentCents(ap) {
  const now = new Date();
  return ap.activity
    .filter((a) => a.type === "purchase" && !a.undone)
    .filter((a) => {
      const d = new Date(a.at);
      return d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth();
    })
    .reduce((s, a) => s + a.amountCents, 0);
}

export function view(ap) {
  return {
    connected: !!ap.vaultId,
    payerEmail: ap.payerEmail,
    connectedAt: ap.connectedAt,
    perOrderLimit: dollars(ap.perOrderLimitCents),
    monthlyLimit: dollars(ap.monthlyLimitCents),
    spentThisMonth: dollars(monthSpentCents(ap)),
    watches: ap.watches.map((w) => ({
      id: w.id,
      productId: w.productId,
      title: w.title,
      targetPrice: dollars(w.targetCents),
      qty: w.qty,
      status: w.status,
      lastPrice: w.lastPrice,
      note: w.note || null,
    })),
    activity: ap.activity.map((a) => ({ ...a, amount: a.amountCents != null ? dollars(a.amountCents) : undefined })),
  };
}

export function setLimits(ap, { per_order_limit, monthly_limit }) {
  if (per_order_limit != null) ap.perOrderLimitCents = cents(per_order_limit);
  if (monthly_limit != null) ap.monthlyLimitCents = cents(monthly_limit);
  if (ap.perOrderLimitCents > ap.monthlyLimitCents) ap.perOrderLimitCents = ap.monthlyLimitCents;
  log(ap, { type: "rules", text: `Limits set: $${dollars(ap.perOrderLimitCents)}/order, $${dollars(ap.monthlyLimitCents)}/month` });
}

export function addWatch(ap, { product_id, target_price, qty = 1 }) {
  const p = getProduct(product_id);
  if (!p) throw new Error("Unknown product_id. Search first and use an id from results.");
  const targetCents = cents(target_price);
  if (targetCents * qty > ap.perOrderLimitCents) {
    throw new Error(`Target total $${dollars(targetCents * qty)} exceeds the per-order limit $${dollars(ap.perOrderLimitCents)}.`);
  }
  const w = {
    id: `w_${Date.now().toString(36)}`,
    productId: p.id,
    title: p.title,
    targetCents,
    qty,
    status: "watching",
    createdAt: new Date().toISOString(),
    lastPrice: p.price,
  };
  ap.watches.push(w);
  log(ap, { type: "watch", text: `Watching ${p.title}: buy ${qty}× when ≤ $${dollars(targetCents)} (now $${p.price})` });
  return w;
}

export function cancelWatch(ap, watchId) {
  const w = ap.watches.find((x) => x.id === watchId);
  if (!w) throw new Error("Watch not found");
  w.status = "cancelled";
  log(ap, { type: "watch", text: `Stopped watching ${w.title}` });
  return w;
}

export async function revoke(ap) {
  if (ap.vaultId) {
    try {
      await deletePaymentToken(ap.vaultId);
    } catch (e) {
      console.warn("[autopilot] delete token failed:", e.message);
    }
  }
  ap.vaultId = null;
  ap.customerId = null;
  ap.watches.filter((w) => w.status === "watching").forEach((w) => (w.status = "paused"));
  log(ap, { type: "revoke", text: "PayPal access revoked. Saved payment method deleted, watches paused." });
}

export async function undoPurchase(session, ap, activityId) {
  const a = ap.activity.find((x) => x.id === activityId && x.type === "purchase");
  if (!a) throw new Error("Purchase not found");
  if (a.undone) throw new Error("Already undone");
  const r = await refundCapture(a.captureId, undefined, "Undone from CartPilot Autopilot");
  a.undone = true;
  await saveOrder({ orderId: a.orderId, status: "REFUNDED", refunds: [{ id: r.id, cents: a.amountCents, status: r.status }] });
  log(ap, { type: "refund", text: `Undid purchase of ${a.title}. Refunded $${dollars(a.amountCents)}`, orderId: a.orderId });
  return r;
}

// ---------- The watcher: evaluates every active watch against live prices and the rules ----------
async function evaluate(session) {
  const ap = session.autopilot;
  if (!ap) return;
  for (const w of ap.watches.filter((x) => x.status === "watching")) {
    const price = await getCurrentPrice(w.productId);
    if (price == null) continue;
    w.lastPrice = price;
    const unitCents = cents(price);
    if (unitCents > w.targetCents) continue; // not yet

    if (!ap.vaultId) {
      w.note = "Price target hit, but PayPal is not connected";
      continue;
    }
    const totalCents = unitCents * w.qty;
    if (totalCents > ap.perOrderLimitCents) {
      w.status = "blocked";
      log(ap, { type: "blocked", text: `Skipped ${w.title}: $${dollars(totalCents)} exceeds per-order limit $${dollars(ap.perOrderLimitCents)}` });
      continue;
    }
    if (monthSpentCents(ap) + totalCents > ap.monthlyLimitCents) {
      w.status = "blocked";
      log(ap, { type: "blocked", text: `Skipped ${w.title}: would exceed monthly limit $${dollars(ap.monthlyLimitCents)}` });
      continue;
    }

    w.status = "buying"; // lock against double purchase
    try {
      const lines = [{ id: w.productId, title: w.title, priceCents: unitCents, qty: w.qty }];
      const order = await chargeVaulted(lines, ap.vaultId, { description: `CartPilot Autopilot: ${w.title}` });
      const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
      if (order.status !== "COMPLETED" || !capture) throw new Error(`Order ${order.id} ended as ${order.status}`);
      w.status = "bought";
      await saveOrder({
        orderId: order.id,
        sessionId: session.id,
        status: "COMPLETED",
        captureId: capture.id,
        totalCents,
        lines,
        refunds: [],
        source: "autopilot",
      });
      log(ap, {
        type: "purchase",
        text: `Bought ${w.qty}× ${w.title} at $${price} (target $${dollars(w.targetCents)})`,
        title: w.title,
        orderId: order.id,
        captureId: capture.id,
        amountCents: totalCents,
      });
      // Let the chat agent know on the next turn.
      (session.notes ||= []).push(`Autopilot bought ${w.qty}x ${w.title} for $${dollars(totalCents)} (order ${order.id}).`);
    } catch (e) {
      w.status = "error";
      w.note = e.message;
      log(ap, { type: "error", text: `Purchase failed for ${w.title}: ${e.message}` });
      console.error("[autopilot]", e.message, e.details ? JSON.stringify(e.details) : "");
    }
  }
}

let running = false;
export function startWatcher() {
  const every = Number(process.env.AUTOPILOT_INTERVAL_MS || 10000);
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      for (const s of allSessions()) await evaluate(s);
    } finally {
      running = false;
    }
  }, every);
  console.log(`[autopilot] watcher running every ${every / 1000}s`);
}
