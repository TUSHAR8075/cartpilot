// Session state (in memory) + order history (MongoDB if MONGODB_URI is set, else memory).
import mongoose from "mongoose";

const sessions = new Map();

export function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, {
      id,
      messages: [], // Anthropic message history
      cart: [], // [{id, title, priceCents, qty, image}]
      budgetCents: null,
      pendingOrderId: null,
    });
  }
  return sessions.get(id);
}

export const cartTotalCents = (cart) => cart.reduce((s, l) => s + l.priceCents * l.qty, 0);

// ---- Orders ----
const memOrders = new Map();
let OrderModel = null;

export async function initDb() {
  if (!process.env.MONGODB_URI) {
    console.log("[store] MONGODB_URI not set: orders kept in memory");
    return;
  }
  await mongoose.connect(process.env.MONGODB_URI);
  OrderModel = mongoose.model(
    "Order",
    new mongoose.Schema(
      {
        orderId: { type: String, unique: true },
        sessionId: String,
        status: String,
        captureId: String,
        totalCents: Number,
        lines: Array,
        payerEmail: String,
        refunds: Array,
      },
      { timestamps: true }
    )
  );
  console.log("[store] connected to MongoDB");
}

export async function saveOrder(order) {
  if (OrderModel) {
    return OrderModel.findOneAndUpdate({ orderId: order.orderId }, order, { upsert: true, new: true }).lean();
  }
  const merged = { ...(memOrders.get(order.orderId) || {}), ...order, updatedAt: new Date() };
  memOrders.set(order.orderId, merged);
  return merged;
}

export async function findOrder(orderId) {
  if (OrderModel) return OrderModel.findOne({ orderId }).lean();
  return memOrders.get(orderId) || null;
}

export async function findOrderByCapture(captureId) {
  if (OrderModel) return OrderModel.findOne({ captureId }).lean();
  return [...memOrders.values()].find((o) => o.captureId === captureId) || null;
}

export async function listOrders(sessionId) {
  if (OrderModel) return OrderModel.find({ sessionId }).sort({ createdAt: -1 }).lean();
  return [...memOrders.values()].filter((o) => o.sessionId === sessionId).reverse();
}
