const KEY = "cartpilot.session";

export function getSessionId() {
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return (window.__cpSession ||= crypto.randomUUID());
  }
}

async function req(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  config: () => req("/api/config"),
  chat: (message) => req("/api/chat", { method: "POST", body: JSON.stringify({ message, sessionId: getSessionId() }) }),
  capture: (orderId) =>
    req(`/api/orders/${orderId}/capture`, { method: "POST", body: JSON.stringify({ sessionId: getSessionId() }) }),
  orders: () => req(`/api/orders?sessionId=${getSessionId()}`),
  autopilot: () => req(`/api/autopilot?sessionId=${getSessionId()}`),
  setupToken: () => req("/api/autopilot/setup-token", { method: "POST", body: JSON.stringify({ sessionId: getSessionId() }) }),
  connect: (setupTokenId) =>
    req("/api/autopilot/connect", { method: "POST", body: JSON.stringify({ sessionId: getSessionId(), setupTokenId }) }),
  revoke: () => req("/api/autopilot/revoke", { method: "POST", body: JSON.stringify({ sessionId: getSessionId() }) }),
  undo: (activityId) =>
    req(`/api/autopilot/undo/${activityId}`, { method: "POST", body: JSON.stringify({ sessionId: getSessionId() }) }),
  dashboard: () => req(`/api/dashboard?sessionId=${getSessionId()}`),
  setLimits: (per_order_limit, monthly_limit) =>
    req("/api/autopilot/limits", { method: "POST", body: JSON.stringify({ sessionId: getSessionId(), per_order_limit, monthly_limit }) }),
  cancelWatch: (id) =>
    req(`/api/autopilot/watches/${id}/cancel`, { method: "POST", body: JSON.stringify({ sessionId: getSessionId() }) }),
  demoPrice: (productId, price) => req("/api/demo/price", { method: "POST", body: JSON.stringify({ productId, price }) }),
};
