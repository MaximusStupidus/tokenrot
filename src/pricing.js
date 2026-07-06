// API-equivalent pricing (USD per 1M tokens). Edit these to match current rates.
// Cache multipliers vs base input: 5-min write = 1.25x, 1-hour write = 2.0x, cache read = 0.1x.
// Numbers are estimates for computing an *API-equivalent* value; your flat subscription may cost far less.

export const PRICES = {
  opus: { in: 15, out: 75, est: false },
  sonnet: { in: 3, out: 15, est: false },
  haiku: { in: 0.8, out: 4, est: false },
  fable: { in: 6, out: 30, est: true }, // Claude 5 family; pricing estimated
  gpt: { in: 2.5, out: 10, est: true }, // Codex / GPT (rough)
  default: { in: 3, out: 15, est: true },
};

const WEB_SEARCH_PER_1K = 10; // server-side web search

export function priceFor(model = "") {
  const m = String(model).toLowerCase();
  if (m.includes("opus")) return PRICES.opus;
  if (m.includes("sonnet")) return PRICES.sonnet;
  if (m.includes("haiku")) return PRICES.haiku;
  if (m.includes("fable")) return PRICES.fable;
  if (m.includes("gpt") || m.includes("codex") || m.includes("o1") || m.includes("o3")) return PRICES.gpt;
  if (m.includes("synthetic")) return { in: 0, out: 0, est: false }; // internal, not billed
  return PRICES.default;
}

// Cost in USD for one usage record. u = { input, output, cacheRead, cacheWrite5m, cacheWrite1h, webSearch }
export function costOf(model, u) {
  const p = priceFor(model);
  const M = 1e6;
  const cost =
    (u.input * p.in +
      u.output * p.out +
      u.cacheRead * p.in * 0.1 +
      u.cacheWrite5m * p.in * 1.25 +
      u.cacheWrite1h * p.in * 2.0) /
      M +
    (u.webSearch || 0) * (WEB_SEARCH_PER_1K / 1000);
  return cost;
}
