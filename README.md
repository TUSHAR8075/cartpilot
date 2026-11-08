# 🛒 CartPilot: an AI shopping agent that checks out with PayPal

> Tell it what you need and your budget. CartPilot searches products, compares them, builds a cart within budget and creates a real **PayPal order**. You approve it in one tap, and it can handle refunds later.
>
> **Autopilot:** save PayPal once and set spending limits. The agent then watches prices and **buys for you while you're away**, never above your limits, with every purchase logged and undoable.

**Built for:** *Build What's Next with PayPal and AI*. **Categories:** Agentic Commerce · PayPal + AI · Channel3 · Render

---

## The problem
Online shopping means 10+ tabs, comparing specs and tracking a budget by hand. AI assistants can *recommend* products, but they stop before the hard part: **paying safely**. CartPilot closes that loop. The agent does the legwork, PayPal handles the money, and **the human always approves the payment**.

## Features
### 🤖 Autopilot: delegated spending with guardrails
- **Connect PayPal once** with **PayPal Vault** (setup token → payment token). The shopper approves in PayPal and nothing is charged
- **Spending rules**: per-order and monthly limits, enforced **in server code** (not just in the prompt), with a month-to-date spend meter
- **Price watches**: *"Buy the mechanical keyboard when it drops under $50"*. A background watcher checks prices and pays with the saved PayPal account (`payment_source.paypal.vault_id`), with no shopper action needed
- **Every purchase is logged and can be undone**: the activity log has one-click **Undo** (Payments v2 refund); **Revoke** deletes the saved payment method at PayPal and pauses all watches
- Purchases that would break a rule are **skipped and logged**, never made

### 📊 Dashboard (AG Grid)
- **KPI tiles**: Autopilot spend vs monthly limit, on/off status, paid orders, autonomous buys, purchases blocked by rules, refunds
- **Editable spending rules** (per order / per month) and **Revoke PayPal**
- **AG Grid** tables: **Price watches** (target vs current price, gap to target, simulate a drop, stop), **Orders** (source: 🤖 Autopilot or 💬 Chat, status, refunds), **Activity log** (every Autopilot decision, with **Undo**)
- Sorting, filters, quick search across grids, pagination and **CSV export**. Updates live every 4 seconds

### Interactive shopping
- 💬 **Natural-language shopping**, e.g. *"Running shoes + socks for my first 10K, budget $90"*
- 🔎 **Live product search** through the Channel3 API, with a built-in demo catalog as fallback
- 💰 **Budget guardrails**: the agent cannot add items that push the cart over budget (enforced server-side)
- 🧾 **PayPal Orders v2 checkout** with itemized line items, created by the agent
- ✅ **Human-in-the-loop payment**: the shopper approves in PayPal Smart Buttons, then the server captures
- ↩️ **Agentic refunds**: *"Refund the socks from my last order"* triggers a partial refund through the Payments v2 API
- 🔔 **PayPal Webhooks** (`PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`) with signature verification
- 🧠 **Transparent agent steps**: every tool call is shown in the chat ("Searching…", "Creating PayPal order…")

## Architecture
```
React (Vite) ── /api/chat ──► Express ──► Claude (tool use loop)
   │                              │            ├─ search_products ─► Channel3 / demo catalog
   │                              │            ├─ set_budget / add_to_cart / remove_from_cart / view_cart
   │                              │            ├─ checkout ───────► PayPal Orders v2 (create)
   │                              │            ├─ get_order_status► PayPal Orders v2 (get)
   │                              │            ├─ refund_order ───► PayPal Payments v2 (refund)
   │                              │            └─ set_spending_limits / create_price_watch / cancel_price_watch / autopilot_status
   ├─ Connect PayPal (vault) ───► /api/autopilot/setup-token ─► PayPal Vault v3 setup token
   │                    approve ► /api/autopilot/connect ─────► PayPal Vault v3 payment token
   │                              Autopilot watcher (every 10s) ► price check ► limits ► Orders v2 w/ vault_id (auto-capture)
   └─ Undo / Revoke ────────────► Payments v2 refund / Vault v3 DELETE payment token
   └─ PayPal Buttons ─ approve ─► /api/orders/:id/capture ─► PayPal Orders v2 (capture)
                                  /api/webhooks/paypal ◄── PayPal Webhooks
                                  MongoDB: sessions, carts, Autopilot state, orders · AG Grid dashboard
```

## Tools used
| Tool | How it's used |
|---|---|
| **PayPal Orders v2** | Agent creates itemized orders; server captures after buyer approval |
| **PayPal JS SDK** (`@paypal/react-paypal-js`) | Smart Buttons for buyer approval |
| **PayPal Payments v2** | Full or partial refunds triggered by the agent |
| **PayPal Vault v3** | Setup tokens + payment tokens to save PayPal for merchant-initiated Autopilot purchases; delete on revoke |
| **PayPal Webhooks** | Keeps order status in sync, with signature verification |
| **Anthropic Claude** | The shopping agent: reasons about needs and budget, calls 9 tools in a loop |
| **Channel3** | Live product search across real merchants: picks the cheapest in-stock offer, shows real images, merchant links and discounts; Autopilot refreshes prices from the product detail endpoint |
| **Render** | Hosting (`render.yaml` included) |
| **MongoDB** | Persists sessions (chat, carts), Autopilot rules, watches and activity, and the order history |
| **AG Grid** (Community) | Dashboard grids for watches, orders and the Autopilot activity log, with custom cell renderers, filters, quick search and CSV export |

## Run locally

**Prerequisites:** Node 18+, a [PayPal Developer](https://developer.paypal.com) account and an Anthropic API key.

1. **PayPal Sandbox app:** Dashboard → Apps & Credentials → *Sandbox* → Create App. Copy the Client ID and Secret. Under *Sandbox accounts*, note the **Personal** (buyer) account email and password for testing.
2. **Clone and configure**
   ```bash
   git clone <your-repo-url> cartpilot && cd cartpilot
   cp server/.env.example server/.env   # fill in PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, ANTHROPIC_API_KEY (+ CHANNEL3_API_KEY)
   # MongoDB: run a local mongod (default URI in .env.example) or use a free MongoDB Atlas cluster
   ```
3. **Install and run**
   ```bash
   npm install            # installs concurrently
   npm run install:all
   npm run dev            # server :8080, client :5173
   ```
4. Open **http://localhost:5173**, try a suggestion, say *"yes, check out"* and pay with the **sandbox buyer account**.

### Production build
```bash
npm run build && npm start   # Express serves client/dist on :8080
```

### Deploy to Render
New → Blueprint → select this repo (it uses `render.yaml`), then fill in the secret env vars.
For webhooks, add `https://<your-app>.onrender.com/api/webhooks/paypal` in your PayPal sandbox app, subscribe to `PAYMENT.CAPTURE.*` and set `PAYPAL_WEBHOOK_ID`.

## Demo script (under 3 minutes)
**Autopilot (the headline):**
1. In the Autopilot panel click **PayPal** and approve with the sandbox buyer. Status shows **ON**, nothing is charged.
2. *"Limits: $60 per order, $100 a month. Buy the mechanical keyboard automatically when it drops under $50."*
3. Click **🧪 Simulate price drop**, a clearly labeled demo helper (disable it with `DEMO_PRICE_SIMULATION=false`). Within about 10 seconds Autopilot buys it, and the activity log and orders show 🤖 COMPLETED.
4. Click **Undo**. The purchase is refunded. Click **Revoke**. The saved payment method is deleted at PayPal.

**Interactive shopping:**
1. *"I need running shoes and socks for my first 10K, budget $90."* The agent sets the budget, searches and compares.
2. *"Go with the Strider and the merino socks."* The cart fills and the budget meter updates.
3. *"Add the GPS watch too."* The agent refuses because it's over budget (guardrail).
4. *"Check out."* A PayPal order is created. Approve it with the sandbox buyer. Status shows **COMPLETED**.
5. *"Refund the socks."* A partial refund goes through. Status shows **PARTIALLY_REFUNDED**.

## Safety design
- Prices are taken from the server-side product cache, never from the model's text
- Budget is enforced in code, not just in the prompt
- The agent can **create** orders but never **captures** them. Capture happens only after the buyer approves in PayPal
- Refunds are limited to the shopper's own captured orders and to the remaining refundable balance
- Autopilot can only spend through a payment method the shopper explicitly saved, only within limits checked in code before every charge, with a lock against double purchases, and the shopper can revoke it at any time

> **Testing note:** PayPal's checkout pop-up needs a normal browser (Chrome, Safari or Edge). If your sandbox app shows Vault errors, enable **Save payment methods** under your app's features in the PayPal Developer Dashboard.

## License
MIT. See [LICENSE](LICENSE).
