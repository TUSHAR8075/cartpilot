import { useState } from "react";
import { PayPalButtons } from "@paypal/react-paypal-js";
import { api } from "./api.js";

const ICON = { purchase: "🛍️", refund: "↩️", blocked: "⛔", watch: "👀", rules: "📏", connect: "🔗", revoke: "🔒", error: "⚠️" };
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export default function AutopilotPanel({ ap, setAp, paypalReady, demoPrices, onError }) {
  const [busy, setBusy] = useState(null);
  if (!ap) return null;

  const run = async (key, fn) => {
    setBusy(key);
    try {
      const next = await fn();
      if (next && "connected" in next) setAp(next);
      else setAp(await api.autopilot());
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const pct = ap.monthlyLimit ? Math.min(100, (ap.spentThisMonth / ap.monthlyLimit) * 100) : 0;
  const active = ap.watches.filter((w) => w.status !== "cancelled");

  return (
    <div className="panel autopilot">
      <h3>
        🤖 Autopilot{" "}
        <span className={`badge ${ap.connected ? "on" : "off"}`}>{ap.connected ? "ON" : "OFF"}</span>
      </h3>
      <p className="muted">
        Save PayPal once and set limits. CartPilot buys items when they hit your target price, never above your limits.
      </p>

      <div className="rules">
        <div><span className="muted">Per order</span><b>${ap.perOrderLimit.toFixed(2)}</b></div>
        <div><span className="muted">Monthly</span><b>${ap.monthlyLimit.toFixed(2)}</b></div>
        <div><span className="muted">Spent</span><b>${ap.spentThisMonth.toFixed(2)}</b></div>
      </div>
      <div className="meter"><div style={{ width: `${pct}%` }} /></div>

      {ap.connected ? (
        <div className="connected">
          <span>🔗 PayPal connected{ap.payerEmail ? ` · ${ap.payerEmail}` : ""}</span>
          <button className="small ghost" disabled={busy === "revoke"} onClick={() => run("revoke", api.revoke)}>
            Revoke
          </button>
        </div>
      ) : paypalReady ? (
        <div className="connect">
          <p className="muted">Connect PayPal so Autopilot can pay. Nothing is charged now.</p>
          <PayPalButtons
            fundingSource="paypal"
            style={{ layout: "horizontal", label: "paypal", height: 40, tagline: false }}
            createVaultSetupToken={async () => (await api.setupToken()).id}
            onApprove={async ({ vaultSetupToken }) => run("connect", () => api.connect(vaultSetupToken))}
            onError={(err) => onError(`PayPal: ${err?.message || err}`)}
          />
        </div>
      ) : (
        <p className="muted">Set PAYPAL_CLIENT_ID on the server.</p>
      )}

      <h4>Watching</h4>
      {active.length === 0 ? (
        <p className="muted">Ask the agent, e.g. “Buy this when it drops under $50”.</p>
      ) : (
        active.map((w) => (
          <div className="watch" key={w.id}>
            <div>
              <div className="title">{w.qty}× {w.title}</div>
              <div className="muted">
                now ${Number(w.lastPrice).toFixed(2)} · target ≤ ${w.targetPrice.toFixed(2)}
                {w.note ? ` · ${w.note}` : ""}
              </div>
            </div>
            <span className={`status ${w.status}`}>{w.status}</span>
            {w.status === "watching" && demoPrices && (
              <button
                className="small ghost"
                title="For demos: simulates the price falling below your target"
                disabled={busy === w.id}
                onClick={() => run(w.id, () => api.demoPrice(w.productId, Math.max(0.5, w.targetPrice - 1)))}
              >
                🧪 Simulate price drop
              </button>
            )}
          </div>
        ))
      )}

      <h4>Activity</h4>
      {ap.activity.length === 0 ? (
        <p className="muted">Nothing yet.</p>
      ) : (
        <ul className="activity">
          {ap.activity.slice(0, 12).map((a) => (
            <li key={a.id} className={a.undone ? "undone" : ""}>
              <span className="when">{time(a.at)}</span>
              <span>{ICON[a.type] || "•"} {a.text}</span>
              {a.type === "purchase" && !a.undone && (
                <button className="small ghost" disabled={busy === a.id} onClick={() => run(a.id, () => api.undo(a.id))}>
                  Undo
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
