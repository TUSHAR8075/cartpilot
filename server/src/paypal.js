// Thin PayPal REST client: OAuth, Orders v2, Payments v2 (refunds), Webhook verification.
const BASE = () => process.env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com";
export const CURRENCY = () => process.env.PAYPAL_CURRENCY || "USD";

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = process.env;
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    throw new Error("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set");
  }
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${BASE()}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`PayPal auth failed: ${JSON.stringify(data)}`);
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

async function ppFetch(path, { method = "GET", body, headers = {} } = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(data.message || `PayPal ${method} ${path} failed (${res.status})`);
    err.details = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

const money = (cents) => (cents / 100).toFixed(2);

/** Create an order from cart lines [{id, title, priceCents, qty}]. */
export async function createOrder(lines, { description = "CartPilot order" } = {}) {
  const currency_code = CURRENCY();
  const totalCents = lines.reduce((s, l) => s + l.priceCents * l.qty, 0);
  return ppFetch("/v2/checkout/orders", {
    method: "POST",
    headers: { "PayPal-Request-Id": `cp-${Date.now()}-${Math.random().toString(36).slice(2)}` },
    body: {
      intent: "CAPTURE",
      purchase_units: [
        {
          description: description.slice(0, 127),
          amount: {
            currency_code,
            value: money(totalCents),
            breakdown: { item_total: { currency_code, value: money(totalCents) } },
          },
          items: lines.map((l) => ({
            name: l.title.slice(0, 127),
            sku: String(l.id).slice(0, 127),
            quantity: String(l.qty),
            category: "PHYSICAL_GOODS",
            unit_amount: { currency_code, value: money(l.priceCents) },
          })),
        },
      ],
    },
  });
}

// ---------- PayPal Vault (save PayPal for future, merchant-initiated purchases) ----------
const reqId = () => `cp-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** Step 1: setup token the buyer approves in the PayPal popup (no money moves). */
export function createSetupToken({ returnUrl = "https://example.com/return", cancelUrl = "https://example.com/cancel" } = {}) {
  return ppFetch("/v3/vault/setup-tokens", {
    method: "POST",
    headers: { "PayPal-Request-Id": reqId() },
    body: {
      payment_source: {
        paypal: {
          description: "CartPilot Autopilot: buys items for you within the limits you set",
          usage_pattern: "IMMEDIATE",
          usage_type: "MERCHANT",
          customer_type: "CONSUMER",
          permit_multiple_payment_tokens: true,
          experience_context: {
            brand_name: "CartPilot",
            return_url: returnUrl,
            cancel_url: cancelUrl,
          },
        },
      },
    },
  });
}

/** Step 2: exchange the approved setup token for a long-lived payment token (vault id). */
export function createPaymentToken(setupTokenId) {
  return ppFetch("/v3/vault/payment-tokens", {
    method: "POST",
    headers: { "PayPal-Request-Id": reqId() },
    body: { payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } } },
  });
}

/** Revoke: deletes the saved payment method at PayPal. */
export const deletePaymentToken = (vaultId) =>
  ppFetch(`/v3/vault/payment-tokens/${vaultId}`, { method: "DELETE" });

/** Merchant-initiated purchase with the saved PayPal account. Returns the completed order. */
export async function chargeVaulted(lines, vaultId, { description = "CartPilot Autopilot purchase" } = {}) {
  const currency_code = CURRENCY();
  const totalCents = lines.reduce((s, l) => s + l.priceCents * l.qty, 0);
  let order = await ppFetch("/v2/checkout/orders", {
    method: "POST",
    headers: { "PayPal-Request-Id": reqId() },
    body: {
      intent: "CAPTURE",
      purchase_units: [
        {
          description: description.slice(0, 127),
          amount: {
            currency_code,
            value: money(totalCents),
            breakdown: { item_total: { currency_code, value: money(totalCents) } },
          },
          items: lines.map((l) => ({
            name: l.title.slice(0, 127),
            sku: String(l.id).slice(0, 127),
            quantity: String(l.qty),
            category: "PHYSICAL_GOODS",
            unit_amount: { currency_code, value: money(l.priceCents) },
          })),
        },
      ],
      payment_source: { paypal: { vault_id: vaultId } },
    },
  });
  // Vaulted CAPTURE orders normally complete in one call; capture explicitly if not.
  if (order.status === "APPROVED" || order.status === "CREATED") order = await captureOrder(order.id);
  return order;
}

export const getOrder = (orderId) => ppFetch(`/v2/checkout/orders/${orderId}`);

export const captureOrder = (orderId) =>
  ppFetch(`/v2/checkout/orders/${orderId}/capture`, { method: "POST" });

export function refundCapture(captureId, amountCents, note = "Refund issued by CartPilot") {
  const body = { note_to_payer: note.slice(0, 255) };
  if (amountCents) body.amount = { value: money(amountCents), currency_code: CURRENCY() };
  return ppFetch(`/v2/payments/captures/${captureId}/refund`, { method: "POST", body });
}

/** Verifies a webhook via PayPal's verify-webhook-signature endpoint. */
export async function verifyWebhook(headers, event) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) return true; // verification disabled in local dev
  const data = await ppFetch("/v1/notifications/verify-webhook-signature", {
    method: "POST",
    body: {
      auth_algo: headers["paypal-auth-algo"],
      cert_url: headers["paypal-cert-url"],
      transmission_id: headers["paypal-transmission-id"],
      transmission_sig: headers["paypal-transmission-sig"],
      transmission_time: headers["paypal-transmission-time"],
      webhook_id: webhookId,
      webhook_event: event,
    },
  });
  return data.verification_status === "SUCCESS";
}
