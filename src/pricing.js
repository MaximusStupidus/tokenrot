// API-equivalent pricing (USD per 1M tokens). These are the BUNDLED FALLBACK —
// on each run the CLI tries to fetch a live price list (see src/prices.js) and
// overrides this table via applyLivePrices(). Offline, these values are used.
// Cache multipliers vs base input: 5-min write = 1.25x, 1-hour write = 2.0x, cache read = 0.1x.

const BUNDLED = {
  opus: { in: 15, out: 75, est: false },
  sonnet: { in: 3, out: 15, est: false },
  haiku: { in: 0.8, out: 4, est: false },
  fable: { in: 6, out: 30, est: true }, // Claude 5 family; pricing estimated
  gpt: { in: 2.5, out: 10, est: true }, // Codex / GPT (rough)
  default: { in: 3, out: 15, est: true },
};

// Active (mutable) tables — start from the bundled fallback.
export const PRICES = { ...BUNDLED };
let CACHE = { read: 0.1, write5m: 1.25, write1h: 2.0 };
let WEB_SEARCH_PER_1K = 10; // server-side web search

// Merge a fetched live price list over the active tables. Tolerant of partial data.
export function applyLivePrices(json) {
  if (!json || typeof json !== "object") return false;
  if (json.models && typeof json.models === "object") {
    for (const [k, v] of Object.entries(json.models)) {
      if (v && isFinite(v.in) && isFinite(v.out)) PRICES[k] = { in: +v.in, out: +v.out, est: !!v.est };
    }
  }
  if (json.cache) {
    if (isFinite(json.cache.read)) CACHE.read = +json.cache.read;
    if (isFinite(json.cache.write5m)) CACHE.write5m = +json.cache.write5m;
    if (isFinite(json.cache.write1h)) CACHE.write1h = +json.cache.write1h;
  }
  if (isFinite(json.webSearchPer1k)) WEB_SEARCH_PER_1K = +json.webSearchPer1k;
  return true;
}

export function priceFor(model = "") {
  const m = String(model).toLowerCase();
  if (m.includes("opus")) return PRICES.opus;
  if (m.includes("sonnet")) return PRICES.sonnet;
  if (m.includes("haiku")) return PRICES.haiku;
  if (m.includes("fable")) return PRICES.fable;
  if (m.includes("gpt") || m.includes("codex") || m.includes("o1") || m.includes("o3") || m.includes("o4")) return PRICES.gpt;
  if (m.includes("synthetic")) return { in: 0, out: 0, est: false }; // internal, not billed
  return PRICES.default;
}

// Cost in USD for one usage record. u = { input, output, cacheRead, cacheWrite5m, cacheWrite1h, webSearch }
export function costOf(model, u) {
  const p = priceFor(model);
  const M = 1e6;
  return (
    (u.input * p.in +
      u.output * p.out +
      u.cacheRead * p.in * CACHE.read +
      u.cacheWrite5m * p.in * CACHE.write5m +
      u.cacheWrite1h * p.in * CACHE.write1h) /
      M +
    (u.webSearch || 0) * (WEB_SEARCH_PER_1K / 1000)
  );
}
