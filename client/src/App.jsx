import { useEffect, useRef, useState } from "react";
import { PayPalScriptProvider, PayPalButtons } from "@paypal/react-paypal-js";
import { api } from "./api.js";

const SUGGESTIONS = [
  "I need running shoes and socks for my first 10K, budget $90",
  "Gift for a coffee-loving friend under $50",
  "Set up a home workout kit for under $45",
];

const TOOL_LABELS = {
  search_products: (i) => `Searching "${i.query}"${i.max_price ? ` under $${i.max_price}` : ""}`,
  set_budget: (i) => `Budget set to $${i.amount}`,
  add_to_cart: (i) => `Adding ${i.qty || 1}× ${i.product_id} to cart`,
  remove_from_cart: (i) => `Removing ${i.product_id}`,
  view_cart: () => "Checking cart",
  checkout: () => "Creating PayPal order",
  get_order_status: (i) => `Checking order ${i.order_id}`,
  list_my_orders: () => "Looking up your orders",
  refund_order: (i) => `Refunding order ${i.order_id}${i.amount ? ` ($${i.amount})` : ""}`,
};

export default function App() {
  const [config, setConfig] = useState(null);
  const [messages, setMessages] = useState([
    { role: "assistant", text: "Hi! I'm CartPilot. Tell me what you need and your budget. I'll find it, build the cart and check out with PayPal." },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState({ items: [], total: 0, budget: null });
  const [order, setOrder] = useState(null); // {orderId, total}
  const [orders, setOrders] = useState([]);
  const endRef = useRef(null);

  useEffect(() => {
    api.config().then(setConfig).catch((e) => setConfig({ error: e.message }));
    api.orders().then(setOrders).catch(() => {});
  }, []);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function send(text) {
    const msg = (text ?? input).trim();
    if (!msg || busy) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", text: msg }]);
    setBusy(true);
    try {
      const { reply, events, pendingOrderId } = await api.chat(msg);
      const steps = [];
      for (const e of events) {
        if (e.type === "tool") steps.push(TOOL_LABELS[e.name]?.(e.input) || e.name);
        if (e.type === "products") setProducts(e.products);
        if (e.type === "cart") setCart(e.cart);
        if (e.type === "checkout") setOrder({ orderId: e.orderId, total: e.total });
        if (e.type === "refund") api.orders().then(setOrders);
      }
      if (!pendingOrderId) setOrder(null); // server clears it when the cart changes
      setMessages((m) => [...m, { role: "assistant", text: reply, steps }]);
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", text: `⚠️ ${e.message}`, error: true }]);
    } finally {
      setBusy(false);
    }
  }

  async function onApprove(data) {
    const result = await api.capture(data.orderID);
    setOrder(null);
    setCart({ items: [], total: 0, budget: cart.budget });
    setOrders(await api.orders());
    const name = result.payer?.given_name ? `, ${result.payer.given_name}` : "";
    setMessages((m) => [
      ...m,
      { role: "assistant", text: `✅ Payment ${result.status}${name}! Order ${data.orderID} is confirmed. Need anything else, or a refund later? Just ask.` },
    ]);
  }

  const paypalReady = config?.paypalClientId;

  return (
    <div className="app">
      <header>
        <div className="brand">🛒 CartPilot</div>
        <div className="sub">AI shopping agent · pays with PayPal (Sandbox)</div>
        {config?.catalog && <span className="pill">catalog: {config.catalog}</span>}
      </header>

      <main>
        <section className="chat">
          <div className="messages">
            {messages.map((m, i) => (
              <div key={i} className={`msg ${m.role} ${m.error ? "error" : ""}`}>
                {m.steps?.length > 0 && (
                  <ul className="steps">
                    {m.steps.map((s, j) => (
                      <li key={j}>⚙️ {s}</li>
                    ))}
                  </ul>
                )}
                <div className="bubble">{m.text}</div>
              </div>
            ))}
            {busy && <div className="msg assistant"><div className="bubble typing">Thinking…</div></div>}
            <div ref={endRef} />
          </div>
          {messages.length === 1 && (
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)}>{s}</button>
              ))}
            </div>
          )}
          <form className="composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="e.g. Buy me a desk lamp under $30" disabled={busy} />
            <button disabled={busy || !input.trim()}>Send</button>
          </form>
        </section>

        <aside>
          <div className="panel">
            <h3>Results</h3>
            {products.length === 0 ? <p className="muted">Products the agent finds appear here.</p> : (
              <div className="grid">
                {products.map((p) => (
                  <div className="card" key={p.id}>
                    {p.image && <img src={p.image} alt="" />}
                    <div className="title">{p.title}</div>
                    <div className="meta">{p.brand}{p.rating ? ` · ★ ${p.rating}` : ""}</div>
                    <div className="row">
                      <b>${p.price.toFixed(2)}</b>
                      <button className="small" disabled={busy} onClick={() => send(`Add ${p.title} (id ${p.id}) to my cart`)}>Add</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="panel">
            <h3>Cart {cart.budget != null && <span className="muted">· budget ${cart.budget.toFixed(2)}</span>}</h3>
            {cart.items.length === 0 ? <p className="muted">Empty</p> : (
              <>
                {cart.items.map((l) => (
                  <div className="line" key={l.product_id}>
                    <span>{l.qty}× {l.title}</span><span>${(l.unit_price * l.qty).toFixed(2)}</span>
                  </div>
                ))}
                <div className="line total"><span>Total</span><span>${cart.total.toFixed(2)}</span></div>
                {cart.budget != null && (
                  <div className="meter"><div style={{ width: `${Math.min(100, (cart.total / cart.budget) * 100)}%` }} /></div>
                )}
                {!order && <button className="wide" disabled={busy} onClick={() => send("Looks good, check out please")}>Ask agent to check out</button>}
              </>
            )}

            {order && (
              <div className="checkout">
                <p>Approve <b>${order.total.toFixed(2)}</b> with PayPal</p>
                {paypalReady ? (
                  <PayPalScriptProvider options={{ clientId: config.paypalClientId, currency: config.currency, intent: "capture" }}>
                    <PayPalButtons
                      key={order.orderId}
                      style={{ layout: "vertical", shape: "rect" }}
                      createOrder={() => order.orderId}
                      onApprove={onApprove}
                      onError={(err) => setMessages((m) => [...m, { role: "assistant", text: `⚠️ PayPal error: ${err?.message || err}`, error: true }])}
                    />
                  </PayPalScriptProvider>
                ) : <p className="muted">Set PAYPAL_CLIENT_ID on the server.</p>}
              </div>
            )}
          </div>

          <div className="panel">
            <h3>Orders</h3>
            {orders.length === 0 ? <p className="muted">No orders yet.</p> : orders.map((o) => (
              <div className="line" key={o.orderId}>
                <span className="mono">{o.orderId}</span>
                <span className={`status ${o.status}`}>{o.status}</span>
                <span>${(o.totalCents / 100).toFixed(2)}</span>
              </div>
            ))}
          </div>
        </aside>
      </main>
    </div>
  );
}
