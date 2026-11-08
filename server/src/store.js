// Session state (in memory) + order history (MongoDB if MONGODB_URI is set, else memory).
import mongoose from "mongoose";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Sessions (chat history, cart, Autopilot rules/watches/vault id) are kept in memory
// and snapshotted to server/.data/sessions.json so restarts don't lose them.
const DATA_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.data/sessions.json");
const sessions = new Map();
try {
  for (const s of JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))) sessions.set(s.id, s);
  console.log(`[store] restored ${sessions.size} session(s)`);
} catch {
  /* first run */
}
let saveTimer = null;
export function persistSessions() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify([...sessions.values()]));
    } catch (e) {
      console.warn("[store] could not persist sessions:", e.message);
    }
  }, 300);
}
setInterval(persistSessions, 5000).unref();

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

export const allSessions = () => sessions.values();

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
        source: String,
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
