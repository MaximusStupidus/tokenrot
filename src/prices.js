import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyLivePrices } from "./pricing.js";

const API_BASE = process.env.TOKENROT_API || "https://tokenrot.comsync.in";

function cacheFile() {
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "tokenrot");
  return { dir, file: path.join(dir, "prices.json") };
}

// Load prices before any cost math. Order: live fetch → local cache → bundled fallback.
// Never throws; returns { source, updated } for display. Sends NO user data (plain GET).
export async function loadPrices({ offline = false } = {}) {
  if (!offline) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 2000);
    try {
      const r = await fetch(API_BASE + "/prices", { signal: ac.signal, headers: { accept: "application/json" } });
      if (r.ok) {
        const json = await r.json();
        if (applyLivePrices(json)) {
          writeCache(json);
          return { source: "live", updated: json.updated || null };
        }
      }
    } catch {
      /* fall through to cache/bundled */
    } finally {
      clearTimeout(t);
    }
  }
  // offline or fetch failed → try cache
  const cached = readCache();
  if (cached && applyLivePrices(cached)) return { source: "cache", updated: cached.updated || null };
  return { source: "bundled", updated: null };
}

function writeCache(json) {
  try {
    const { dir, file } = cacheFile();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(json));
  } catch {
    /* cache is best-effort */
  }
}
function readCache() {
  try {
    return JSON.parse(fs.readFileSync(cacheFile().file, "utf8"));
  } catch {
    return null;
  }
}
