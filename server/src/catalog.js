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

function normalizeChannel3(prod) {
  const offer = (prod.offers || [])[0] || {};
  const rawPrice = typeof offer.price === "object" ? offer.price?.price ?? offer.price?.amount : offer.price;
  const img = prod.image_url || prod.images?.[0]?.url || prod.images?.[0];
  return {
    id: prod.id,
    title: prod.title,
    brand: prod.brand_name || prod.brands?.[0]?.name || "",
    category: prod.category || "",
    price: Number(rawPrice ?? prod.price ?? 0),
    rating: null,
    image: typeof img === "string" ? img : null,
    merchant: offer.domain || "",
    url: offer.url || null,
  };
}

async function channel3Search({ query, max_price, min_price, limit }) {
  const filters = {};
  if (max_price || min_price) filters.price = { ...(min_price && { min_price }), ...(max_price && { max_price }) };
  const res = await fetch("https://api.trychannel3.com/v1/search", {
    method: "POST",
    headers: { "x-api-key": process.env.CHANNEL3_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit, ...(Object.keys(filters).length && { filters }) }),
  });
  if (!res.ok) throw new Error(`Channel3 search failed (${res.status})`);
  const data = await res.json();
  return (data.products || []).map(normalizeChannel3).filter((p) => p.price > 0);
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

/** Latest price for a product (used by the Autopilot watcher). */
export async function getCurrentPrice(id) {
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

/** Demo-only: simulate a price change in the built-in catalog (for live demos). */
export function setDemoPrice(id, price) {
  const p = productCache.get(id);
  if (!p || !DEMO.some((d) => d.id === id)) throw new Error("Only demo-catalog products can be repriced");
  p.price = Number(Number(price).toFixed(2));
  return p;
}
export const catalogSource = () => (process.env.CHANNEL3_API_KEY ? "channel3" : "demo");
