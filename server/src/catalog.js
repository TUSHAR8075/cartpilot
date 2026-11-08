// Product search: Channel3 when CHANNEL3_API_KEY is set, otherwise a built-in demo catalog.
const DEMO = [
  { id: "shoe-001", title: "Strider Road Running Shoe", brand: "Velo", category: "running shoes", price: 59.99, rating: 4.4, tags: ["cushioned", "daily trainer", "men", "women"] },
  { id: "shoe-002", title: "AeroLite Racing Flat", brand: "Kestrel", category: "running shoes", price: 89.0, rating: 4.6, tags: ["lightweight", "race", "carbon plate"] },
  { id: "shoe-003", title: "TrailGrip All-Terrain Runner", brand: "Summit", category: "running shoes", price: 74.5, rating: 4.3, tags: ["trail", "waterproof", "grip"] },
  { id: "shoe-004", title: "CloudStep Recovery Shoe", brand: "Velo", category: "running shoes", price: 44.99, rating: 4.1, tags: ["budget", "comfort", "walking"] },
  { id: "sock-001", title: "Merino Running Socks (3-pack)", brand: "Woolly", category: "socks", price: 18.0, rating: 4.7, tags: ["merino", "anti-blister"] },
  { id: "bottle-001", title: "Insulated Steel Water Bottle 750ml", brand: "Hydra", category: "bottles", price: 22.0, rating: 4.8, tags: ["insulated", "gym", "hiking"] },
  { id: "watch-001", title: "PacePro GPS Running Watch", brand: "Kestrel", category: "watches", price: 149.0, rating: 4.5, tags: ["gps", "heart rate", "running"] },
  { id: "ear-001", title: "SweatProof Wireless Earbuds", brand: "Sonix", category: "earbuds", price: 39.99, rating: 4.2, tags: ["wireless", "sport", "budget"] },
  { id: "ear-002", title: "Studio ANC Earbuds", brand: "Sonix", category: "earbuds", price: 119.0, rating: 4.6, tags: ["noise cancelling", "premium"] },
  { id: "bag-001", title: "Commuter Laptop Backpack 25L", brand: "Nomad", category: "backpacks", price: 54.0, rating: 4.5, tags: ["laptop", "waterproof", "travel"] },
  { id: "bag-002", title: "Ultralight Daypack 18L", brand: "Summit", category: "backpacks", price: 32.0, rating: 4.3, tags: ["hiking", "packable"] },
  { id: "mug-001", title: "Ceramic Pour-Over Coffee Set", brand: "Brewhaus", category: "coffee", price: 34.0, rating: 4.6, tags: ["gift", "coffee", "kitchen"] },
  { id: "coffee-001", title: "Single-Origin Ethiopian Beans 500g", brand: "Brewhaus", category: "coffee", price: 16.5, rating: 4.8, tags: ["coffee", "gift"] },
  { id: "lamp-001", title: "Dimmable LED Desk Lamp", brand: "Lumen", category: "lamps", price: 27.99, rating: 4.4, tags: ["desk", "study", "usb-c"] },
  { id: "kb-001", title: "Mechanical Keyboard 75% (Hot-swap)", brand: "Keyforge", category: "keyboards", price: 69.0, rating: 4.7, tags: ["mechanical", "developer", "rgb"] },
  { id: "mouse-001", title: "Ergonomic Wireless Mouse", brand: "Keyforge", category: "mice", price: 29.0, rating: 4.4, tags: ["ergonomic", "wireless"] },
  { id: "mat-001", title: "Non-Slip Yoga Mat 6mm", brand: "Zenfit", category: "yoga", price: 25.0, rating: 4.5, tags: ["yoga", "fitness", "home workout"] },
  { id: "band-001", title: "Resistance Bands Set (5 levels)", brand: "Zenfit", category: "fitness", price: 14.99, rating: 4.3, tags: ["home workout", "budget", "fitness"] },
  { id: "book-001", title: "Notebook Set — Dotted A5 (2-pack)", brand: "Inkwell", category: "stationery", price: 12.0, rating: 4.6, tags: ["gift", "study", "journal"] },
  { id: "plant-001", title: "Self-Watering Herb Planter", brand: "Greenly", category: "home", price: 36.0, rating: 4.2, tags: ["gift", "kitchen", "plants"] },
].map((p) => ({
  ...p,
  image: `https://picsum.photos/seed/${p.id}/320/240`,
  merchant: "CartPilot Demo Store",
}));

const productCache = new Map(); // id -> normalized product (so add_to_cart can trust prices)
DEMO.forEach((p) => productCache.set(p.id, p));

function scoreDemo(p, terms) {
  const hay = `${p.title} ${p.brand} ${p.category} ${p.tags.join(" ")}`.toLowerCase();
  return terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
}

function demoSearch({ query, max_price, min_price, limit }) {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  return DEMO.map((p) => ({ p, s: scoreDemo(p, terms) }))
    .filter(({ p, s }) => s > 0 && (!max_price || p.price <= max_price) && (!min_price || p.price >= min_price))
    .sort((a, b) => b.s - a.s || b.p.rating - a.p.rating)
    .slice(0, limit)
    .map(({ p }) => p);
}

// Channel3 Product: { id, title, description, brands:[{id,name}], images:[{url, cleaned_url, is_main_image}],
//   category:{slug,title}, offers:[{url, domain, price:{price, compare_at_price, currency}, availability}] }
function normalizeChannel3(prod) {
  const offers = (prod.offers || []).filter((o) => o?.price?.price > 0);
  const usd = offers.filter((o) => (o.price.currency || "USD").toUpperCase() === "USD");
  const pool = (usd.length ? usd : offers).sort(
    (x, y) => (x.availability === "InStock" ? 0 : 1) - (y.availability === "InStock" ? 0 : 1) || x.price.price - y.price.price
  );
  const offer = pool[0] || {};
  const imgs = prod.images || [];
  const img = imgs.find((i) => i.is_main_image) || imgs[0];
  return {
    id: prod.id,
    title: prod.title,
    brand: prod.brands?.[0]?.name || "",
    category: prod.category?.title || "",
    price: Number(offer.price?.price ?? 0),
    compareAt: offer.price?.compare_at_price ?? null,
    currency: offer.price?.currency || "USD",
    inStock: offer.availability ? offer.availability === "InStock" : null,
    rating: null,
    image: img ? img.cleaned_url || img.url : null,
    merchant: offer.domain || "",
    url: offer.url || null,
    offers: offers.length,
  };
}

async function channel3Search({ query, max_price, min_price, limit }) {
  const filters = {};
  if (max_price || min_price) filters.price = { ...(min_price && { min_price }), ...(max_price && { max_price }) };
  const res = await fetch("https://api.trychannel3.com/v1/search", {
    method: "POST",
    headers: { "x-api-key": process.env.CHANNEL3_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit: Math.min(limit, 30), ...(Object.keys(filters).length && { filters }) }),
  });
  if (!res.ok) throw new Error(`Channel3 search failed (${res.status})`);
  const data = await res.json();
  return (data.products || []).map(normalizeChannel3).filter((p) => p.price > 0 && p.inStock !== false);
}

export async function searchProducts({ query, max_price, min_price, limit = 5 }) {
  let results;
  if (process.env.CHANNEL3_API_KEY) {
    try {
      results = await channel3Search({ query, max_price, min_price, limit });
    } catch (e) {
      console.warn("[catalog] Channel3 failed, using demo catalog:", e.message);
    }
  }
  if (!results) results = demoSearch({ query, max_price, min_price, limit });
  results.forEach((p) => productCache.set(p.id, p));
  return results;
}

export const getProduct = (id) => productCache.get(id) || null;

// Demo price overrides (for live demos/videos). Disabled when DEMO_PRICE_SIMULATION=false.
const priceOverrides = new Map();
export const demoSimulationEnabled = () => process.env.DEMO_PRICE_SIMULATION !== "false";

/** Latest price for a product (used by the Autopilot watcher). */
export async function getCurrentPrice(id) {
  if (priceOverrides.has(id)) return priceOverrides.get(id);
  const cached = productCache.get(id);
  const isDemo = DEMO.some((d) => d.id === id);
  if (process.env.CHANNEL3_API_KEY && cached && !isDemo) {
    try {
      const res = await fetch(`https://api.trychannel3.com/v1/products/${encodeURIComponent(id)}`, {
        headers: { "x-api-key": process.env.CHANNEL3_API_KEY },
      });
      if (res.ok) {
        const fresh = normalizeChannel3(await res.json());
        if (fresh.price > 0) productCache.set(id, { ...cached, ...fresh });
        return fresh.price || cached.price;
      }
    } catch (e) {
      console.warn("[catalog] price refresh failed:", e.message);
    }
  }
  return cached ? cached.price : null;
}

/** Demo-only: simulate a price change (works for demo and live-catalog products; clearly labeled in the UI). */
export function setDemoPrice(id, price) {
  if (!demoSimulationEnabled()) throw new Error("Price simulation is disabled");
  const p = productCache.get(id);
  if (!p) throw new Error("Unknown product");
  const v = Number(Number(price).toFixed(2));
  priceOverrides.set(id, v);
  if (DEMO.some((d) => d.id === id)) p.price = v;
  return { id, price: v };
}

export function clearDemoPrice(id) {
  priceOverrides.delete(id);
}
export const catalogSource = () => (process.env.CHANNEL3_API_KEY ? "channel3" : "demo");
