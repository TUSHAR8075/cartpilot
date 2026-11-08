// Tools the shopping agent can call. Each returns JSON for the model and may emit UI events.
import { searchProducts, getProduct } from "./catalog.js";
import { createOrder, getOrder, refundCapture } from "./paypal.js";
import { cartTotalCents, saveOrder, findOrder, listOrders } from "./store.js";
import { getAutopilot, view as autopilotView, setLimits, addWatch, cancelWatch } from "./autopilot.js";

const cents = (n) => Math.round(Number(n) * 100);
const dollars = (c) => Number((c / 100).toFixed(2));

const cartView = (s) => ({
  items: s.cart.map((l) => ({ product_id: l.id, title: l.title, unit_price: dollars(l.priceCents), qty: l.qty })),
  total: dollars(cartTotalCents(s.cart)),
  budget: s.budgetCents != null ? dollars(s.budgetCents) : null,
});

export const toolDefs = [
  {
    name: "search_products",
    description:
      "Search the product catalog. Use specific queries (e.g. 'trail running shoes'). Returns ids, titles, prices (USD), brand, rating.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        max_price: { type: "number", description: "Maximum unit price in USD" },
        min_price: { type: "number" },
        limit: { type: "integer", minimum: 1, maximum: 10 },
      },
      required: ["query"],
    },
  },
  {
    name: "set_budget",
    description: "Record the shopper's total budget in USD. The cart total must never exceed it.",
    input_schema: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] },
  },
  {
    name: "add_to_cart",
    description: "Add a product (by id from search results) to the cart.",
    input_schema: {
      type: "object",
      properties: { product_id: { type: "string" }, qty: { type: "integer", minimum: 1 } },
      required: ["product_id"],
    },
  },
  {
    name: "remove_from_cart",
    description: "Remove a product from the cart entirely.",
    input_schema: { type: "object", properties: { product_id: { type: "string" } }, required: ["product_id"] },
  },
  {
    name: "view_cart",
    description: "Show current cart contents, total and budget.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "checkout",
    description:
      "Create a PayPal order for the current cart. Only call after the shopper confirms they want to buy. The shopper then approves the payment in the PayPal button; you never capture payment yourself.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_order_status",
    description: "Look up the PayPal status of an order (CREATED, APPROVED, COMPLETED...).",
    input_schema: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
  },
  {
    name: "list_my_orders",
    description: "List this shopper's past orders.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "refund_order",
    description:
      "Refund a COMPLETED order, fully or partially. Only call after the shopper explicitly asks for a refund and confirms the amount.",
    input_schema: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        amount: { type: "number", description: "Partial refund amount in USD. Omit for a full refund." },
        reason: { type: "string" },
      },
      required: ["order_id"],
    },
  },
  {
    name: "autopilot_status",
    description:
      "Autopilot state: whether PayPal is connected for autonomous purchases, spending limits, month-to-date spend, price watches and recent activity.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "set_spending_limits",
    description: "Set Autopilot spending rules in USD. Only call with values the shopper stated.",
    input_schema: {
      type: "object",
      properties: { per_order_limit: { type: "number" }, monthly_limit: { type: "number" } },
    },
  },
  {
    name: "create_price_watch",
    description:
      "Ask Autopilot to buy a product automatically (with the shopper's saved PayPal) once its price is at or below target_price. Only create after the shopper agrees to the product, target price and quantity.",
    input_schema: {
      type: "object",
      properties: {
        product_id: { type: "string" },
        target_price: { type: "number", description: "Max unit price in USD" },
        qty: { type: "integer", minimum: 1 },
      },
      required: ["product_id", "target_price"],
    },
  },
  {
    name: "cancel_price_watch",
    description: "Stop a price watch by id.",
    input_schema: { type: "object", properties: { watch_id: { type: "string" } }, required: ["watch_id"] },
  },
];

export async function runTool(name, input, session, emit) {
  switch (name) {
    case "search_products": {
      const products = await searchProducts({ ...input, limit: input.limit || 5 });
      emit({ type: "products", products });
      return products.map(({ id, title, brand, price, rating, merchant }) => ({ id, title, brand, price, rating, merchant }));
    }
    case "set_budget": {
      session.budgetCents = cents(input.amount);
      emit({ type: "cart", cart: cartView(session) });
      return cartView(session);
    }
    case "add_to_cart": {
      const p = getProduct(input.product_id);
      if (!p) return { error: "Unknown product_id. Search first and use an id from results." };
      const qty = input.qty || 1;
      const line = session.cart.find((l) => l.id === p.id);
      const projected = cartTotalCents(session.cart) + cents(p.price) * qty;
      if (session.budgetCents != null && projected > session.budgetCents) {
        return { error: `Over budget: total would be $${dollars(projected)} vs budget $${dollars(session.budgetCents)}.` };
      }
      if (line) line.qty += qty;
      else session.cart.push({ id: p.id, title: p.title, priceCents: cents(p.price), qty, image: p.image });
      session.pendingOrderId = null; // cart changed: any earlier order is stale
      emit({ type: "cart", cart: cartView(session) });
      return cartView(session);
    }
    case "remove_from_cart": {
      session.cart = session.cart.filter((l) => l.id !== input.product_id);
      session.pendingOrderId = null;
      emit({ type: "cart", cart: cartView(session) });
      return cartView(session);
    }
    case "view_cart":
      return cartView(session);
    case "checkout": {
      if (!session.cart.length) return { error: "Cart is empty." };
      const order = await createOrder(session.cart, { description: `CartPilot: ${session.cart.length} item(s)` });
      session.pendingOrderId = order.id;
      await saveOrder({
        orderId: order.id,
        sessionId: session.id,
        status: order.status,
        totalCents: cartTotalCents(session.cart),
        lines: session.cart.map((l) => ({ ...l })),
        refunds: [],
      });
      emit({ type: "checkout", orderId: order.id, total: dollars(cartTotalCents(session.cart)) });
      return { order_id: order.id, status: order.status, note: "PayPal button shown to shopper for approval." };
    }
    case "get_order_status": {
      const o = await getOrder(input.order_id);
      return { order_id: o.id, status: o.status, amount: o.purchase_units?.[0]?.amount };
    }
    case "list_my_orders": {
      const orders = await listOrders(session.id);
      return orders.map((o) => ({
        order_id: o.orderId,
        status: o.status,
        total: dollars(o.totalCents),
        items: o.lines?.map((l) => `${l.qty}x ${l.title}`),
        refunded: dollars((o.refunds || []).reduce((s, r) => s + r.cents, 0)),
      }));
    }
    case "refund_order": {
      const o = await findOrder(input.order_id);
      if (!o || o.sessionId !== session.id) return { error: "Order not found for this shopper." };
      if (!o.captureId) return { error: `Order is ${o.status}; only captured orders can be refunded.` };
      const refundedSoFar = (o.refunds || []).reduce((s, r) => s + r.cents, 0);
      const amountCents = input.amount ? cents(input.amount) : o.totalCents - refundedSoFar;
      if (amountCents <= 0 || refundedSoFar + amountCents > o.totalCents) {
        return { error: `Refundable balance is $${dollars(o.totalCents - refundedSoFar)}.` };
      }
      const r = await refundCapture(o.captureId, input.amount ? amountCents : undefined, input.reason);
      const refunds = [...(o.refunds || []), { id: r.id, cents: amountCents, status: r.status }];
      await saveOrder({
        orderId: o.orderId,
        refunds,
        status: refundedSoFar + amountCents >= o.totalCents ? "REFUNDED" : "PARTIALLY_REFUNDED",
      });
      const act = session.autopilot?.activity.find((a) => a.type === "purchase" && a.orderId === o.orderId);
      if (act && refundedSoFar + amountCents >= o.totalCents) act.undone = true;
      emit({ type: "refund", orderId: o.orderId, amount: dollars(amountCents) });
      return { refund_id: r.id, status: r.status, amount: dollars(amountCents) };
    }
    case "autopilot_status": {
      const v = autopilotView(getAutopilot(session));
      return { ...v, activity: v.activity.slice(0, 8) };
    }
    case "set_spending_limits": {
      const ap = getAutopilot(session);
      setLimits(ap, input);
      emit({ type: "autopilot" });
      return autopilotView(ap);
    }
    case "create_price_watch": {
      const ap = getAutopilot(session);
      const w = addWatch(ap, input);
      emit({ type: "autopilot" });
      return {
        watch_id: w.id,
        status: w.status,
        paypal_connected: !!ap.vaultId,
        note: ap.vaultId ? "Autopilot will buy automatically when the target is hit." : "Ask the shopper to click 'Connect PayPal' in the Autopilot panel so purchases can run.",
      };
    }
    case "cancel_price_watch": {
      const ap = getAutopilot(session);
      cancelWatch(ap, input.watch_id);
      emit({ type: "autopilot" });
      return { ok: true };
    }
    default:
      return { error: `Unknown tool ${name}` };
  }
}
