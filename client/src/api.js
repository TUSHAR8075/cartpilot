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
};
