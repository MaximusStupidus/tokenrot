// tokenrot compare server — Bun + bun:sqlite, zero external deps.
// Stores only anonymous aggregate numbers. No accounts. No IP logging.
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.PORT || 7200);
const DB_PATH = process.env.VIBEAUDIT_DB || "./tokenrot.db";
const BASE = process.env.PUBLIC_BASE || "https://tokenrot.comsync.in";

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`CREATE TABLE IF NOT EXISTS subs (
  id TEXT PRIMARY KEY,
  handle TEXT UNIQUE,
  tool TEXT, plan REAL,
  totalUsd REAL, monthUsd REAL, projectedUsd REAL, avgDailyUsd REAL,
  genPct REAL, rereadPct REAL, opusSharePct REAL, anomalyRatio REAL,
  spanDays INTEGER, activeDays INTEGER,
  tokTotal REAL, tokOutput REAL, tokCacheRead REAL,
  updatedAt INTEGER
);`);
try { db.exec("ALTER TABLE subs ADD COLUMN handle TEXT"); db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_handle ON subs(handle)"); } catch {} // existing DBs
// survey labels (anonymous, optional) + synthetic seed flag (purge: DELETE FROM subs WHERE synthetic=1)
for (const col of ["role TEXT", "tools TEXT", "pays TEXT", "aiShare TEXT", "feels TEXT", "synthetic INTEGER DEFAULT 0"]) { try { db.exec(`ALTER TABLE subs ADD COLUMN ${col}`); } catch {} }
// Survey labels: preset values pass through; "add your own" free text is scrubbed
// to a safe charset and capped (it may be rendered on the site later).
const cleanLabel = (v) => { const t = String(v ?? "").toLowerCase().replace(/[^a-z0-9 %_\/-]/g, "").replace(/\s+/g, " ").trim().slice(0, 40); return t || null; };

// Mailing list + privacy-preserving visit counter (daily totals only — no ids, no IPs).
db.exec(`CREATE TABLE IF NOT EXISTS emails (email TEXT PRIMARY KEY, ts INTEGER, source TEXT);`);
db.exec(`CREATE TABLE IF NOT EXISTS visits (day TEXT PRIMARY KEY, n INTEGER);`);
const subEmail = db.prepare("INSERT OR IGNORE INTO emails (email, ts, source) VALUES (?, ?, ?)");
const bumpVisit = db.prepare("INSERT INTO visits (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1");

// ── anonymous public handles ─────────────────────────────────────────
// Deterministic-ish meme name from the (secret) id. The handle is the ONLY thing
// shown publicly; the id never appears on shared pages.
const ADJ = ["feral","cracked","turbo","rogue","silent","caffeinated","chaotic","cozy","goated","stealth","reckless","budget","maxxed","sleepless","prompt-pilled","opus-pilled","thrifty","unhinged","zen","overclocked"];
const NOUN = ["tokenlord","cachegoblin","contexthoarder","burnmaxxer","vibecoder","promptsmith","agentwrangler","looprunner","opusenjoyer","tokensmith","rotmaster","compactor","sessionfiend","jsonlgremlin","apiwhale"];
function fnv(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
const getByHandle = () => db.prepare("SELECT * FROM subs WHERE handle = ?");
function makeHandle(id) {
  const h = fnv(id);
  const adj = ADJ[h % ADJ.length], noun = NOUN[(h >>> 5) % NOUN.length];
  let num = (h >>> 16) % 100;
  for (let i = 0; i < 200; i++) {
    const cand = `${adj}-${noun}-${num}`;
    const row = getByHandle().get(cand);
    if (!row || row.id === id) return cand;
    num = (num + 1 + i) % 1000;
  }
  return `${adj}-${noun}-${(Date.now() % 100000)}`;
}

const upsert = db.prepare(`INSERT INTO subs
  (id,handle,role,tools,pays,aiShare,feels,tool,plan,totalUsd,monthUsd,projectedUsd,avgDailyUsd,genPct,rereadPct,opusSharePct,anomalyRatio,spanDays,activeDays,tokTotal,tokOutput,tokCacheRead,updatedAt)
  VALUES ($id,$handle,$role,$tools,$pays,$aiShare,$feels,$tool,$plan,$totalUsd,$monthUsd,$projectedUsd,$avgDailyUsd,$genPct,$rereadPct,$opusSharePct,$anomalyRatio,$spanDays,$activeDays,$tokTotal,$tokOutput,$tokCacheRead,$updatedAt)
  ON CONFLICT(id) DO UPDATE SET
    handle=COALESCE(subs.handle,$handle),
    role=COALESCE($role,subs.role),tools=COALESCE($tools,subs.tools),pays=COALESCE($pays,subs.pays),aiShare=COALESCE($aiShare,subs.aiShare),feels=COALESCE($feels,subs.feels),
    tool=$tool,plan=$plan,totalUsd=$totalUsd,monthUsd=$monthUsd,projectedUsd=$projectedUsd,avgDailyUsd=$avgDailyUsd,
    genPct=$genPct,rereadPct=$rereadPct,opusSharePct=$opusSharePct,anomalyRatio=$anomalyRatio,
    spanDays=$spanDays,activeDays=$activeDays,tokTotal=$tokTotal,tokOutput=$tokOutput,tokCacheRead=$tokCacheRead,updatedAt=$updatedAt`);
const delStmt = db.prepare("DELETE FROM subs WHERE id = ?");
const getRow = db.prepare("SELECT * FROM subs WHERE id = ?");
const countStmt = db.prepare("SELECT COUNT(*) AS n FROM subs");

const METRICS = ["projectedUsd", "genPct", "rereadPct", "opusSharePct", "avgDailyUsd"];
const ID_RE = /^[A-Za-z0-9._-]{8,64}$/;   // anon ids are uuids; reject anything else
const COHORT_TTL_MS = 30_000;              // cache the full-table scan so /submit can't DoS it
const MAX_ROWS = 500_000;                  // hard ceiling on distinct submissions
const num = (v, lo = 0, hi = 1e12) => { const n = Number(v); return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : 0; };

// Cohort values. Cached for read paths (pages/stats — the DoS surface); force=true
// recomputes so a submitter always sees themselves in the fresh cohort.
let _cohort = null, _cohortAt = 0;
function cohortValues(force = false) {
  const now = Date.now();
  if (!force && _cohort && now - _cohortAt < COHORT_TTL_MS) return _cohort;
  const rows = db.query("SELECT " + METRICS.join(",") + " FROM subs").all();
  const cols = {};
  for (const m of METRICS) cols[m] = rows.map((r) => r[m]).filter((v) => v != null && isFinite(v)).sort((a, b) => a - b);
  _cohort = { n: rows.length, cols };
  _cohortAt = now;
  return _cohort;
}
function pctRank(sorted, x) {
  if (!sorted.length) return null;
  let below = 0; for (const v of sorted) if (v < x) below++; else break;
  return Math.round((below / sorted.length) * 100);
}
function median(sorted) { return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null; }

function compareFor(row, force = false) {
  const { n, cols } = cohortValues(force);
  const pct = {}, med = {};
  for (const m of METRICS) { pct[m] = pctRank(cols[m], row[m]); med[m] = round(median(cols[m]), m.endsWith("Usd") ? 0 : 1); }
  return { cohort: n, pct, median: med };
}
const round = (n, d = 0) => { if (n == null) return null; const f = 10 ** d; return Math.round(n * f) / f; };

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });

function sanitize(b) {
  if (!b || typeof b.id !== "string" || !ID_RE.test(b.id)) return null;
  return {
    id: b.id, tool: String(b.tool || "").slice(0, 24) || "Claude Code", plan: b.plan ? num(b.plan, 0, 100000) : null,
    totalUsd: num(b.totalUsd), monthUsd: num(b.monthUsd), projectedUsd: num(b.projectedUsd), avgDailyUsd: num(b.avgDailyUsd),
    genPct: num(b.genPct, 0, 100), rereadPct: num(b.rereadPct, 0, 100), opusSharePct: num(b.opusSharePct, 0, 100),
    anomalyRatio: num(b.anomalyRatio, 0, 1000), spanDays: Math.round(num(b.spanDays, 0, 100000)), activeDays: Math.round(num(b.activeDays, 0, 100000)),
    tokTotal: num(b.tokens?.total), tokOutput: num(b.tokens?.output), tokCacheRead: num(b.tokens?.cacheRead),
    role: Array.isArray(b.role) ? b.role.map(cleanLabel).filter(Boolean).slice(0, 4).join(",") || null : cleanLabel(b.role),
    pays: cleanLabel(b.pays),
    aiShare: cleanLabel(b.aiShare),
    feels: cleanLabel(b.feels),
    tools: Array.isArray(b.tools) ? b.tools.map(cleanLabel).filter(Boolean).slice(0, 7).join(",") || null : null,
    updatedAt: Date.now(),
  };
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (req.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST,GET,OPTIONS" } });
    if (p === "/health") return json({ ok: true });
    if (p === "/prices") return pricesResponse();
    if (p === "/favicon.svg" || p === "/favicon.ico") return new Response(FAVICON_SVG, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
    if (p === "/robots.txt") return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });

    if (p === "/submit" && req.method === "POST") {
      let b; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
      const row = sanitize(b);
      if (!row) return json({ error: "invalid payload" }, 400);
      // hard ceiling: allow updates to existing ids, but stop unbounded new rows (cheap COUNT, no cache priming)
      const existing = getRow.get(row.id);
      if (!existing && countStmt.get().n >= MAX_ROWS) return json({ error: "cohort full" }, 503);
      row.handle = existing?.handle || makeHandle(row.id);
      upsert.run({ ...Object.fromEntries(Object.entries(row).map(([k, v]) => ["$" + k, v])) });
      const cmp = compareFor(row, true); // fresh cohort so the submitter sees themselves
      return json({ ...cmp, handle: row.handle, url: `${BASE}/@${row.handle}`, board: BASE });
    }
    if (p === "/forget" && req.method === "POST") {
      let b; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
      if (typeof b?.id === "string" && ID_RE.test(b.id)) delStmt.run(b.id);
      return json({ ok: true });
    }
    if (p === "/stats") return json(statsPayload());
    if (p === "/subscribe" && req.method === "POST") {
      let b; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
      const email = String(b?.email || "").trim().toLowerCase();
      if (!/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,24}$/.test(email)) return json({ error: "enter a valid email" }, 400);
      subEmail.run(email, Date.now(), String(b?.source || "site").slice(0, 24));
      return json({ ok: true });
    }
    if (p === "/visit" && req.method === "POST") {
      bumpVisit.run(new Date().toISOString().slice(0, 10)); // daily count only — nothing about the visitor
      return json({ ok: true });
    }
    const html = (s) => new Response(s, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (p === "/") return html(pageHtml(null)); // leaderboard (or empty-state)
    if (p.startsWith("/@")) {
      // PUBLIC share page, addressed by anonymous handle — the secret id never appears here
      const handle = decodeURIComponent(p.slice(2)).toLowerCase();
      const row = /^[a-z0-9-]{3,48}$/.test(handle) ? getByHandle().get(handle) : null;
      return html(pageHtml(row ? row.id : null, false, handle));
    }
    if (p.startsWith("/u/")) {
      let id = decodeURIComponent(p.slice(3));
      if (!ID_RE.test(id)) id = null;
      return html(pageHtml(id));
    }
    if (p === "/demo") return html(pageHtml(null, true));
    return new Response("not found", { status: 404 });
  },
});

function statsPayload() {
  const { n, cols } = cohortValues();
  const out = { cohort: n, median: {} };
  for (const m of METRICS) out.median[m] = round(median(cols[m]), m.endsWith("Usd") ? 0 : 1);
  return out;
}

// Live price list — served to the CLI before every cost calc. Edit prices.json to update
// (re-read at most every 60s; no restart needed). Sends nothing about any user.
let _prices = null, _pricesAt = 0;
function pricesResponse() {
  const now = Date.now();
  if (!_prices || now - _pricesAt > 60_000) {
    try { _prices = readFileSync(import.meta.dir + "/prices.json", "utf8"); _pricesAt = now; } catch { _prices = null; }
  }
  if (!_prices) return json({ error: "prices unavailable" }, 503);
  return new Response(_prices, { headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "public, max-age=3600" } });
}

/* ══════════════════════════════════════════════════════════════════════
   PRESENTATION — full-page "terminal display" design.
   Benchmarked against Linear/Vercel/Stripe/Warp/Bun-class dev-tool sites:
   sticky slim nav → full-bleed hero with giant monospace display type over
   the token-decay field → the board as the product → how-it-works → email
   capture → rich footer. One ember accent; contrast turned up; monospace IS
   the display face (terminal-native — that's the signature).
   ══════════════════════════════════════════════════════════════════════ */

// Brand mark: a token meter rotting left-to-right — two ash bars, one ember survivor.
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="13" fill="#0a0c10"/><rect x="11" y="30" width="11" height="23" rx="2.5" fill="#39414f"/><rect x="26.5" y="21" width="11" height="32" rx="2.5" fill="#6b4a2c"/><rect x="42" y="11" width="11" height="42" rx="2.5" fill="#d5813c"/></svg>`;

const CSS = `
:root{
  --bg:#08090d;--surface:#0d1016;--raise:#131722;--line:#20263250;--line2:#242c3a;--hair:#171c26;
  --ink:#cfd4dd;--ink2:#f2f4f8;--dim:#97a0b0;--faint:#5d6675;
  --accent:#e08a43;--accent-hot:#ff9d52;--accent-dim:#8a5a30;--green:#6aa588;--red:#c96a5f;
  --mono:"SF Mono",SFMono-Regular,ui-monospace,Menlo,Consolas,"Liberation Mono",monospace;
  --sans:ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--mono);font-size:13.5px;line-height:1.6;
  -webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
a{color:inherit;text-decoration:none}
.num{font-variant-numeric:tabular-nums}
b{font-weight:700;color:var(--ink2)}
.q{color:var(--dim)}
.container{max-width:1060px;margin:0 auto;padding:0 22px}
.narrow{max-width:860px;margin:0 auto;padding:0 22px}

/* ── nav ── */
.nav{position:sticky;top:0;z-index:50;background:rgba(8,9,13,.82);backdrop-filter:blur(10px);
  -webkit-backdrop-filter:blur(10px);border-bottom:1px solid var(--hair)}
.nav-in{max-width:1060px;margin:0 auto;padding:0 22px;height:56px;display:flex;align-items:center;gap:26px}
.brand{letter-spacing:.3em;font-weight:700;color:var(--ink2);font-size:13px}
.brand b{color:var(--accent)}
.nav-links{display:flex;gap:20px;flex:1;font-size:12px;color:var(--dim)}
.nav-links a:hover{color:var(--ink2)}
.nav-links a.on{color:var(--ink2)}
@media(max-width:620px){.nav-links{gap:14px}}

/* ── buttons ── */
.btn{font-family:var(--mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase;
  border-radius:7px;padding:9px 16px;cursor:pointer;border:1px solid var(--line2);
  background:var(--raise);color:var(--ink);transition:border-color .12s,background .12s,color .12s;white-space:nowrap}
.btn:hover{color:var(--ink2);border-color:var(--accent-dim)}
.btn:active{transform:translateY(1px)}
.btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#140f08;font-weight:700}
.btn.primary:hover{background:var(--accent-hot);border-color:var(--accent-hot);color:#140f08}
.btn.sm{padding:6px 12px;font-size:10px}
a.btn{display:inline-flex;align-items:center}

/* ── hero (full-bleed, carries the decay field) ── */
.hero{position:relative;overflow:hidden;border-bottom:1px solid var(--hair);background:#07080c}
canvas.viz{position:absolute;inset:0;z-index:0;width:100%;height:100%;pointer-events:none;
  -webkit-mask-image:linear-gradient(180deg,#000 0%,#000 82%,transparent 100%);
  mask-image:linear-gradient(180deg,#000 0%,#000 82%,transparent 100%)}
.hero-in{position:relative;z-index:1;max-width:1060px;margin:0 auto;padding:88px 22px 72px}
.hero.compact .hero-in{padding:56px 22px 48px}
.chip{display:inline-flex;align-self:flex-start;align-items:center;gap:9px;background:rgba(13,16,22,.85);border:1px solid var(--line2);
  border-radius:999px;padding:7px 14px;font-size:10.5px;letter-spacing:.18em;text-transform:uppercase;color:var(--ink2);
  backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
.chip .dot{width:6px;height:6px;border-radius:50%;background:var(--accent);animation:pulse 2.4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.display{font-family:var(--mono);font-weight:700;letter-spacing:-.045em;color:var(--ink2);
  font-size:clamp(38px,6.4vw,72px);line-height:1.02;margin:22px 0 0;text-wrap:balance;
  text-shadow:0 0 22px rgba(7,8,12,.95),0 4px 34px rgba(7,8,12,.9)}
.display em{font-style:normal;color:var(--accent)}
.lede{font-family:var(--sans);font-size:clamp(14.5px,1.7vw,17px);color:var(--dim);max-width:56ch;margin:18px 0 0;line-height:1.6;
  text-shadow:0 0 14px rgba(7,8,12,.95)}
.lede b{color:var(--ink)}
.cmdrow{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:30px 0 0}
.cmdbox{display:flex;align-items:center;gap:14px;background:rgba(13,16,22,.9);border:1px solid var(--line2);
  border-radius:9px;padding:13px 18px;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
.cmdbox .cmd{font-size:16px;font-weight:700;color:var(--ink2)}
.cmdbox .cmd .p{color:var(--faint);font-weight:400}.cmdbox .cmd .n{color:var(--accent)}
.herostats{display:flex;gap:44px;flex-wrap:wrap;margin:44px 0 0}
.hs .v{font-size:26px;font-weight:700;color:var(--ink2);letter-spacing:-.02em}
.hs .v.money{color:var(--accent)}
.hs .k{font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--faint);margin-top:2px}

/* ── sections ── */
.sec{padding:64px 0}
.sec.tight{padding:44px 0}
.sec-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:22px}
.sec-head h2{font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim);margin:0;font-weight:700}
.sec-head .r{font-size:11px;color:var(--faint)}
.panel{background:var(--surface);border:1px solid var(--line2);border-radius:12px;overflow:hidden}

/* ── board ── */
.tabs{display:flex;gap:2px;padding:14px 16px 6px}
.tab{font-family:var(--mono);font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);
  background:none;border:1px solid var(--hair);border-radius:6px;padding:5px 12px;cursor:pointer}
.tab:hover{color:var(--ink);border-color:var(--line2)}
.tab.on{color:var(--accent);border-color:var(--accent-dim)}
.tab:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.lb{padding:4px 8px 12px}
.lb-row{display:grid;grid-template-columns:34px minmax(0,1fr) minmax(120px,220px) 110px;gap:12px;align-items:center;
  padding:11px 10px;border-radius:8px;transition:background .12s}
.lb-row:hover{background:var(--raise)}
.lb-rank{text-align:right;color:var(--faint);font-size:12.5px}
.lb-row.r1 .lb-rank,.lb-row.r2 .lb-rank,.lb-row.r3 .lb-rank{color:var(--accent);font-weight:700}
.lb-who{min-width:0}
.lb-handle{font-size:13.5px;font-weight:600;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}
.lb-row:hover .lb-handle{color:var(--ink2)}
.lb-ago{font-size:10.5px;color:var(--faint)}
.lb-burn{text-align:right;font-weight:700;color:var(--accent);font-size:14px}
.lb-burn i{font-style:normal;color:var(--faint);font-size:10.5px;font-weight:400}
.lb-scale{position:relative;height:20px}
.lb-scale .ax{position:absolute;top:10px;left:0;right:0;height:1px;background:var(--hair)}
.lb-scale .fill{position:absolute;top:8px;left:0;height:4px;background:var(--accent-dim);border-radius:2px}
.lb-row.r1 .lb-scale .fill{background:var(--accent)}
@media(max-width:560px){.lb-row{grid-template-columns:28px minmax(0,1fr) 96px}.lb-scale{display:none}}
.ghost{opacity:.35;pointer-events:none}
.claim{margin:4px 16px 16px;border:1px dashed var(--accent-dim);border-radius:9px;padding:14px 18px;
  font-family:var(--sans);font-size:13.5px;color:var(--ink)}
.claim b{color:var(--accent)}

/* ── distribution ── */
.dist{padding:6px 18px 18px}
.dist .d{display:flex;align-items:center;gap:12px;padding:4px 0}
.dist .d .dl{width:76px;text-align:right;color:var(--dim);font-size:11.5px}
.dist .d .dt{flex:1;height:9px;background:var(--raise);border-radius:2px;overflow:hidden}
.dist .d .df{height:100%;background:#3b465c}
.dist .d.you .df{background:var(--accent)}
.dist .d .dc{width:44px;color:var(--faint);font-size:11.5px}
.dist .d.you .dc{color:var(--accent)}

/* ── how it works ── */
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
@media(max-width:720px){.steps{grid-template-columns:1fr}}
.step{background:var(--surface);border:1px solid var(--line2);border-radius:12px;padding:22px 20px}
.step .g{font-size:20px;color:var(--accent);font-weight:700}
.step h3{font-family:var(--sans);font-size:15px;color:var(--ink2);margin:10px 0 6px;font-weight:700}
.step p{font-family:var(--sans);font-size:13px;color:var(--dim);margin:0;line-height:1.55}
.step code{font-family:var(--mono);color:var(--accent);font-size:12px}

/* ── email capture ── */
.updates{background:var(--surface);border:1px solid var(--line2);border-radius:12px;padding:30px 28px;
  display:flex;gap:26px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.updates h3{font-family:var(--mono);font-size:19px;color:var(--ink2);margin:0 0 6px;letter-spacing:-.02em}
.updates p{font-family:var(--sans);font-size:13.5px;color:var(--dim);margin:0;max-width:46ch;line-height:1.55}
.subform{display:flex;gap:10px;flex-wrap:wrap}
.subform input{font-family:var(--mono);font-size:13px;background:var(--bg);border:1px solid var(--line2);
  border-radius:7px;padding:10px 14px;color:var(--ink2);min-width:240px}
.subform input::placeholder{color:var(--faint)}
.subform input:focus{outline:none;border-color:var(--accent-dim)}
.form-msg{font-size:11px;color:var(--green);margin-top:8px;min-height:14px;font-family:var(--sans)}
.form-msg.err{color:var(--red)}

/* ── card pages (/@handle, /demo) ── */
.sheet{max-width:760px;margin:0 auto;background:var(--surface);border:1px solid var(--line2);border-radius:12px;overflow:hidden}
.card-hero{position:relative;overflow:hidden;padding:34px 24px 28px;border-bottom:1px solid var(--hair);background:#090b10;min-height:210px;
  display:flex;flex-direction:column;justify-content:center}
.card-hero>*{position:relative;z-index:1}
.card-hero .display{font-size:clamp(34px,5.4vw,52px)}
.lab{padding:18px 24px 8px;font-size:10.5px;letter-spacing:.18em;text-transform:uppercase;color:var(--faint);
  display:flex;justify-content:space-between;align-items:baseline}
.lab .r{letter-spacing:.02em;text-transform:none}
.finds{padding:4px 24px}
.f{display:grid;grid-template-columns:80px 1fr;gap:16px;align-items:baseline;padding:15px 0;border-bottom:1px solid var(--hair)}
.f:last-child{border-bottom:0}
.f .fm{font-size:25px;font-weight:700;letter-spacing:-.02em;color:var(--accent);line-height:1;text-align:right}
.f .ft{font-family:var(--sans);font-size:14.5px;line-height:1.5;color:var(--ink)}
.meas{padding:0 24px 8px}
.m{padding:12px 0;border-bottom:1px solid var(--hair)}
.m:last-child{border-bottom:0}
.m .mh{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px}
.m .name{color:var(--ink);font-size:12.5px}
.m .vals{display:flex;gap:12px;align-items:baseline}
.m .v{color:var(--ink2);font-weight:700;font-size:13px}
.m .pc{color:var(--dim);font-size:11px;width:66px;text-align:right}
.m .pc b{color:var(--accent)}
.scale{position:relative;height:20px}
.scale .axis{position:absolute;top:10px;left:0;right:0;height:1px;background:#2a3342}
.scale .tick{position:absolute;top:6px;width:1px;height:5px;background:#232c3a}
.scale .med{position:absolute;top:5px;width:7px;height:7px;background:var(--surface);border:1px solid #8b94a6;transform:translate(-50%,0) rotate(45deg)}
.scale .you{position:absolute;top:10px;transform:translateX(-50%)}
.scale .you .cap{position:absolute;left:50%;top:-4px;transform:translateX(-50%);width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:7px solid var(--accent)}
.scale .you .stem{position:absolute;left:50%;top:2px;transform:translateX(-50%);width:1px;height:8px;background:var(--accent)}
.mix{padding:2px 24px 18px}
.mixbar{display:flex;height:9px;border-radius:2px;overflow:hidden;background:var(--raise)}
.mixbar i{display:block;height:100%}
.mixleg{display:flex;gap:20px;margin-top:10px;font-size:11.5px;color:var(--dim)}
.mixleg em{font-style:normal;display:inline-block;width:8px;height:8px;border-radius:1px;margin-right:6px;vertical-align:middle}
.tips{padding:2px 24px 16px}
.tip{padding:11px 0;border-bottom:1px solid var(--hair)}
.tip:last-child{border-bottom:0}
.tip .th{font-family:var(--sans);font-size:14px;color:var(--ink2);font-weight:600}
.tip .th s{text-decoration:none;color:var(--green)}
.tip .ts{font-family:var(--sans);font-size:12.5px;color:var(--dim);margin-top:2px}
.card-cta{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;
  padding:18px 24px;border-top:1px solid var(--line2);background:rgba(224,138,67,.04)}
.card-cta .cmd{font-size:15px;font-weight:700;color:var(--ink2)}
.card-cta .cmd .p{color:var(--faint);font-weight:400}.card-cta .cmd .n{color:var(--accent)}
.hook{font-family:var(--sans);font-size:13px;color:var(--dim);max-width:36ch;text-align:right}
.hook b{color:var(--ink2)}

/* ── terminal demo ── */
.term{background:#06070a;border:1px solid var(--line2);border-radius:10px;padding:18px 20px;
  font-size:12.5px;line-height:1.8;overflow-x:auto;white-space:pre}
.term .p{color:var(--faint)} .term .c{color:var(--ink2)} .term .a{color:var(--accent)} .term .g{color:var(--green)} .term .d{color:var(--dim)}
.term .bar{color:var(--accent-dim)}

/* ── footer ── */
.footer{border-top:1px solid var(--hair);background:var(--surface);margin-top:26px}
.footer-in{max-width:1060px;margin:0 auto;padding:44px 22px 30px;display:grid;grid-template-columns:1.3fr 1fr 1.4fr;gap:36px}
@media(max-width:760px){.footer-in{grid-template-columns:1fr}}
.footer .fb{letter-spacing:.3em;font-weight:700;color:var(--ink2);font-size:13px}
.footer .fb b{color:var(--accent)}
.footer .ftag{font-family:var(--sans);font-size:12.5px;color:var(--dim);margin:10px 0 0;max-width:34ch;line-height:1.55}
.footer .fpriv{font-size:11px;color:var(--faint);margin-top:14px;line-height:1.7}
.footer .fpriv .g{color:var(--green)}
.fcol h4{font-size:10.5px;letter-spacing:.18em;text-transform:uppercase;color:var(--faint);margin:0 0 12px}
.fcol a{display:block;font-size:12.5px;color:var(--dim);padding:3px 0}
.fcol a:hover{color:var(--ink2)}
.legal{max-width:1060px;margin:0 auto;padding:14px 22px 22px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;
  font-size:10.5px;color:var(--faint);border-top:1px solid var(--hair)}

/* ── cookie consent ── */
.cookiebar{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:80;width:min(680px,calc(100vw - 28px));
  background:var(--raise);border:1px solid var(--line2);border-radius:12px;padding:14px 18px;
  display:none;align-items:center;gap:16px;flex-wrap:wrap;box-shadow:0 18px 50px -12px rgba(0,0,0,.7)}
.cookiebar.show{display:flex}
.cookiebar p{font-family:var(--sans);font-size:12.5px;color:var(--ink);margin:0;flex:1;min-width:220px;line-height:1.5}
.cookiebar p b{color:var(--ink2)}

@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}html{scroll-behavior:auto}}
`;

const JS = `
(function(){
  var rm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // count-up
  if (!rm) document.querySelectorAll('[data-n]').forEach(function(el){
    var t = +el.getAttribute('data-n'); if (!isFinite(t)) return;
    var usd = el.getAttribute('data-fmt') === 'usd'; var s = performance.now();
    (function f(now){ var p = Math.min(1,(now-s)/850); var v = t*(1-Math.pow(1-p,3));
      el.textContent = (usd?'$':'') + Math.round(v).toLocaleString('en-US'); if (p<1) requestAnimationFrame(f); })(s);
  });
  // copy npx command
  document.querySelectorAll('.copy').forEach(function(b){
    var orig = b.textContent;
    b.addEventListener('click', function(){
      navigator.clipboard.writeText('npx tokenrot').then(function(){
        b.textContent='copied ✓'; setTimeout(function(){ b.textContent=orig; },1400);
      }).catch(function(){});
    });
  });
  // sort tabs
  var lb = document.querySelector('.lb');
  document.querySelectorAll('.tab').forEach(function(tab){
    tab.addEventListener('click', function(){
      document.querySelectorAll('.tab').forEach(function(t){ t.classList.remove('on'); t.setAttribute('aria-pressed','false'); });
      tab.classList.add('on'); tab.setAttribute('aria-pressed','true');
      var k = tab.getAttribute('data-k');
      var rows = Array.from(lb.querySelectorAll('.lb-row'));
      rows.sort(function(a,b){ return (+b.getAttribute('data-'+k)||0) - (+a.getAttribute('data-'+k)||0); });
      rows.forEach(function(r,i){ r.querySelector('.lb-rank').textContent = i+1;
        r.classList.remove('r1','r2','r3'); if (i<3) r.classList.add('r'+(i+1)); lb.appendChild(r); });
    });
  });
  // live board refresh
  if (lb && location.pathname === '/') setInterval(function(){
    if (document.hidden) return;
    fetch(location.href).then(function(r){ return r.text(); }).then(function(t){
      var doc = new DOMParser().parseFromString(t,'text/html');
      var nb = doc.querySelector('.lb'); if (nb) lb.innerHTML = nb.innerHTML;
    }).catch(function(){});
  }, 60000);
  // mailing list
  document.querySelectorAll('.subform').forEach(function(form){
    form.addEventListener('submit', function(e){
      e.preventDefault();
      var input = form.querySelector('input'), btn = form.querySelector('button'), msg = form.parentElement.querySelector('.form-msg');
      var email = (input.value||'').trim();
      btn.disabled = true;
      fetch('/subscribe', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({email:email, source: location.pathname})})
        .then(function(r){ return r.json(); })
        .then(function(d){
          if (d.ok) { msg.textContent = 'Subscribed — first report lands next month.'; msg.classList.remove('err'); input.value=''; }
          else { msg.textContent = d.error || 'Something went wrong — try again.'; msg.classList.add('err'); }
          btn.disabled = false;
        }).catch(function(){ msg.textContent = 'Network error — try again.'; msg.classList.add('err'); btn.disabled = false; });
    });
  });
  // cookie consent — one first-party cookie, only after an explicit yes
  var bar = document.getElementById('cookiebar');
  function beacon(){
    var day = new Date().toISOString().slice(0,10);
    if (localStorage.getItem('trot_lastping') === day) return;
    localStorage.setItem('trot_lastping', day);
    fetch('/visit', {method:'POST'}).catch(function(){});
  }
  var consent = localStorage.getItem('trot_consent');
  if (consent === 'yes') { beacon(); }
  else if (!consent && bar) { bar.classList.add('show'); }
  if (bar) {
    var acc = document.getElementById('ck-accept'), dec = document.getElementById('ck-decline');
    if (acc) acc.addEventListener('click', function(){
      localStorage.setItem('trot_consent','yes');
      if (!document.cookie.includes('trot_id=')) {
        var id = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
        document.cookie = 'trot_id=' + id + ';path=/;max-age=31536000;SameSite=Lax';
      }
      beacon(); bar.classList.remove('show');
    });
    if (dec) dec.addEventListener('click', function(){
      localStorage.setItem('trot_consent','no'); bar.classList.remove('show');
    });
  }
})();
`;

// ── the 3D signature: a token-decay field ───────────────────────────
// Full-bleed behind the hero. Tokens spawn at the right ember-bright, drift left
// through the context window and rot to ash; the survivors — the % that became
// real code — stay lit and rise. Parameterized per page via __VIZ.
const VIZ_JS = `
(function(){
  if(!window.THREE) return;
  var cv=document.querySelector('canvas.viz'); if(!cv) return;
  var rm=matchMedia('(prefers-reduced-motion: reduce)').matches;
  var P=window.__VIZ||{gen:1,reread:92};
  var W=cv.clientWidth||900,H=cv.clientHeight||420,renderer;
  try{renderer=new THREE.WebGLRenderer({canvas:cv,alpha:true,antialias:false});}catch(e){return;}
  renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));renderer.setSize(W,H,false);
  var scene=new THREE.Scene();
  var cam=new THREE.PerspectiveCamera(55,W/H,.1,100);cam.position.z=17;
  var N=(innerWidth<600?2400:6200);
  var surv=Math.max(.02,(P.gen||1)/100*2);
  var rot=Math.min(1,(P.reread||90)/100);
  var geo=new THREE.BufferGeometry();
  var pos=new Float32Array(N*3),col=new Float32Array(N*3),meta=new Array(N);
  var ember=new THREE.Color('#ff9142'),bright=new THREE.Color('#ffd08e'),ash=new THREE.Color('#414b5e');
  var SPAN=34;
  function reset(i,init){
    pos[i*3]=init?(Math.random()*SPAN*2-SPAN):(SPAN+Math.random()*6);
    pos[i*3+1]=(Math.random()-.5)*11; pos[i*3+2]=(Math.random()-.5)*8;
    meta[i]={v:.02+Math.random()*.045,s:Math.random()<surv,a:init?Math.random():0,w:Math.random()*6.28};
  }
  for(var i=0;i<N;i++)reset(i,true);
  geo.setAttribute('position',new THREE.BufferAttribute(pos,3));
  geo.setAttribute('color',new THREE.BufferAttribute(col,3));
  scene.add(new THREE.Points(geo,new THREE.PointsMaterial({size:.22,vertexColors:true,transparent:true,opacity:1,depthWrite:false,blending:THREE.AdditiveBlending})));
  var mx=0,my=0;
  addEventListener('pointermove',function(e){mx=e.clientX/innerWidth-.5;my=e.clientY/innerHeight-.5;},{passive:true});
  var c=new THREE.Color();
  function tick(t){
    for(var i=0;i<N;i++){
      var m=meta[i];
      pos[i*3]-=m.v;
      pos[i*3+1]+=Math.sin(t*.0006+m.w)*.004+(m.s?.008:0);
      m.a+=m.v/(SPAN*1.7);
      if(pos[i*3]<-SPAN-1)reset(i,false);
      if(m.s)c.copy(bright);else c.copy(ember).lerp(ash,Math.pow(Math.min(1,m.a),.55)*rot+(1-rot)*.2);
      col[i*3]=c.r;col[i*3+1]=c.g;col[i*3+2]=c.b;
    }
    geo.attributes.position.needsUpdate=true;geo.attributes.color.needsUpdate=true;
    cam.position.x+=(mx*2-cam.position.x)*.04;
    cam.position.y+=(-my*1.1-cam.position.y)*.04;
    cam.lookAt(0,0,0);
    renderer.render(scene,cam);
  }
  if(rm){tick(400);renderer.render(scene,cam);return;}
  var run=true;
  document.addEventListener('visibilitychange',function(){run=!document.hidden;});
  (function loop(t){requestAnimationFrame(loop);if(run)tick(t);})(0);
  addEventListener('resize',function(){W=cv.clientWidth;H=cv.clientHeight;if(!W||!H)return;
    renderer.setSize(W,H,false);cam.aspect=W/H;cam.updateProjectionMatrix();},{passive:true});
})();
`;

const HIST_LABELS = ["<$100", "$100–300", "$300–600", "$600–1k", "$1k–2k", "$2k–5k", "$5k+"];
const HIST_EDGES = [0, 100, 300, 600, 1000, 2000, 5000, 1e9];
const DEMO = { handle: "opus-pilled-tokensmith-42", proj: 9240, avgDaily: 304, gen: 0.5, reread: 96, opus: 97, anomaly: 1.6, spendPct: 92, genPct: 12, rereadPct: 91, opusPct: 96, dayPct: 93, cohort: 1284, medProj: 3808, counts: [34, 62, 100, 58, 36, 20, 11], youBucket: 6 };

const $ = (n) => "$" + Math.round(n || 0).toLocaleString("en-US");
const bucketOf = (v) => { for (let i = 0; i < HIST_LABELS.length; i++) if (v < HIST_EDGES[i + 1]) return i; return HIST_LABELS.length - 1; };
function timeAgo(ms) {
  if (!ms) return "";
  const s = Math.max(1, (Date.now() - ms) / 1000);
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}
const ord = (n) => n + (n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th");

function scaleHtml(pct) {
  const x = Math.max(3, Math.min(97, pct));
  return `<div class="scale"><div class="axis"></div>
    <div class="tick" style="left:25%"></div><div class="tick" style="left:50%"></div><div class="tick" style="left:75%"></div>
    <div class="med" style="left:50%"></div><div class="you" style="left:${x}%"><span class="cap"></span><span class="stem"></span></div></div>`;
}
function measRow(name, val, pct) {
  if (pct == null) return "";
  const tag = `<b>${ord(Math.max(1, Math.min(99, pct)))}</b> pctl`;
  return `<div class="m"><div class="mh"><span class="name">${name}</span><span class="vals"><span class="v num">${val}</span><span class="pc num">${tag}</span></span></div>${scaleHtml(pct)}</div>`;
}
function histHtml(counts, youBucket) {
  const maxc = Math.max(1, ...counts);
  return HIST_LABELS.map((lb, i) => `<div class="d${i === youBucket ? " you" : ""}"><span class="dl">${lb}</span>
    <span class="dt"><span class="df" style="width:${Math.round((counts[i] / maxc) * 100)}%"></span></span>
    <span class="dc num">${i === youBucket ? "you" : counts[i]}</span></div>`).join("");
}

// Plain-English pattern findings — the insight, before the evidence.
function findingsHtml(d) {
  const items = [];
  const mult = d.medProj > 0 ? d.proj / d.medProj : null;
  if (mult && mult >= 1.15)
    items.push({ m: mult.toFixed(1) + "×", t: `Burns <b>${mult.toFixed(1)}× the median</b> dev — <b class="num">${$(d.proj)}</b>/mo vs <span class="q num">${$(d.medProj)}</span>. Top ${Math.max(1, 100 - d.spendPct)}% of the board.` });
  else if (mult && mult <= 0.85)
    items.push({ m: Math.round((1 - mult) * 100) + "%", t: `Runs <b>${Math.round((1 - mult) * 100)}% under the median</b> — <b class="num">${$(d.proj)}</b>/mo vs <span class="q num">${$(d.medProj)}</span>. Quietly efficient.` });
  items.push({ m: Math.round(d.reread) + "%", t: `<b>${Math.round(d.reread)}% of tokens re-read context</b> already loaded; only <b class="num">${d.gen}%</b> was newly written code. Paying to reload, not to create.` });
  if (d.opus >= 60)
    items.push({ m: Math.round(d.opus) + "%", t: `<b>Opus drives ${Math.round(d.opus)}% of the bill</b> — the single biggest cost lever on this profile.` });
  if (d.anomaly >= 1.5)
    items.push({ m: "▲", t: `Last 3 days ran <b>${d.anomaly}× the personal norm</b> — the signature of a runaway loop or caching bug.` });
  return items.slice(0, 4).map((i) => `<div class="f"><div class="fm num">${i.m}</div><div class="ft">${i.t}</div></div>`).join("");
}

// Cut-the-burn tips — same deterministic rules as the CLI, rendered on the card.
function tipsHtml(d) {
  const tips = [];
  if (d.opus >= 60 && d.proj > 50)
    tips.push([`Route routine work to Sonnet <s>— saves ~${$(d.proj * (d.opus / 100) * 0.3 * 0.8)}/mo</s>`, `Keep Opus for architecture and hard debugging; /model sonnet for edits, tests, boilerplate.`]);
  if (d.reread >= 85)
    tips.push([`Cut context re-reads <s>— saves ~${$(d.proj * 0.12)}/mo</s>`, `/compact at natural breakpoints, /clear between tasks, trim CLAUDE.md — every turn re-reads it.`]);
  if (d.anomaly >= 1.5)
    tips.push([`Audit the last 3 days for a runaway loop`, `A retrying agent quietly eats 10–100× a normal session.`]);
  if (!tips.length) return "";
  return `<div class="lab"><span>Cut the burn</span><span class="r">computed from these numbers</span></div><div class="tips">` +
    tips.slice(0, 3).map(([h, s]) => `<div class="tip"><div class="th">${h}</div><div class="ts">${s}</div></div>`).join("") + `</div>`;
}

const NAV = (active) => `
<nav class="nav" aria-label="Main"><div class="nav-in">
  <a class="brand" href="/" aria-label="tokenrot home">TOKEN<b>ROT</b></a>
  <div class="nav-links">
    <a href="/" ${active === "board" ? 'class="on" aria-current="page"' : ""}>board</a>
    <a href="/demo" ${active === "demo" ? 'class="on" aria-current="page"' : ""}>demo</a>
    <a href="https://github.com/MaximusStupidus/tokenrot">source</a>
    <a href="#updates">updates</a>
  </div>
  <button class="btn primary sm copy" type="button" aria-label="Copy the command npx tokenrot">npx tokenrot</button>
</div></nav>`;

const UPDATES_SECTION = `
<section class="sec tight" id="updates"><div class="container">
  <div class="updates">
    <div>
      <h3>The Burn Report</h3>
      <p>Once a month: what the cohort actually spent, which models got throttled, and where the money leaked. Written from the board's data — <b>no spam, unsubscribe anytime.</b></p>
    </div>
    <div>
      <form class="subform" novalidate>
        <input type="email" name="email" placeholder="you@dev.email" autocomplete="email" aria-label="Email address" required/>
        <button class="btn primary" type="submit">subscribe</button>
      </form>
      <div class="form-msg" role="status" aria-live="polite"></div>
    </div>
  </div>
</div></section>`;

const COOKIEBAR = `
<div class="cookiebar" id="cookiebar" role="dialog" aria-label="Cookie consent">
  <p><b>One cookie, no trackers.</b> We'd like to set a single first-party cookie to count visits. No IPs, no fingerprinting, no third parties — that's the whole product ethos.</p>
  <button class="btn primary" id="ck-accept" type="button">allow</button>
  <button class="btn" id="ck-decline" type="button">decline</button>
</div>`;

const FOOTER = `
<footer class="footer">
  <div class="footer-in">
    <div>
      <div class="fb">TOKEN<b>ROT</b></div>
      <p class="ftag">The independent watchdog for AI-coding spend. Reads your local logs, prices the burn, ranks you anonymously.</p>
      <p class="fpriv"><span class="g">●</span> local-first · anonymous handles · no accounts · no IPs stored · delete anytime with <span class="num">tokenrot --forget</span></p>
    </div>
    <div class="fcol">
      <h4>Product</h4>
      <a href="/">the board</a>
      <a href="/demo">demo report</a>
      <a href="/prices">live prices</a>
      <a href="https://github.com/MaximusStupidus/tokenrot">source on GitHub</a>
      <a href="https://github.com/MaximusStupidus/tokenrot/blob/main/docs/PRIVACY.md">privacy</a>
    </div>
    <div class="fcol">
      <h4>Get the Burn Report</h4>
      <form class="subform" novalidate>
        <input type="email" name="email" placeholder="you@dev.email" autocomplete="email" aria-label="Email address" required/>
        <button class="btn primary" type="submit">subscribe</button>
      </form>
      <div class="form-msg" role="status" aria-live="polite"></div>
    </div>
  </div>
  <div class="legal"><span>© 2026 tokenrot · MIT · runs on your machine</span><span>npx tokenrot</span></div>
</footer>`;

function shell({ title, ogDesc, body, path = "/", viz = null, active = "" }) {
  const canonical = BASE + path;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<link rel="canonical" href="${canonical}"/>
<link rel="icon" type="image/svg+xml" href="/favicon.svg"/>
<link rel="mask-icon" href="/favicon.svg" color="#e08a43"/>
<meta property="og:type" content="website"/>
<meta property="og:site_name" content="tokenrot"/>
<meta property="og:url" content="${canonical}"/>
<meta property="og:title" content="${title}"/>
<meta property="og:description" content="${ogDesc}"/>
<meta name="twitter:card" content="summary"/>
<meta name="twitter:title" content="${title}"/>
<meta name="twitter:description" content="${ogDesc}"/>
<meta name="description" content="${ogDesc}"/>
<meta name="theme-color" content="#08090d"/>
<style>${CSS}</style></head><body>
${NAV(active)}
<main>${body}</main>
${UPDATES_SECTION}
${FOOTER}
${COOKIEBAR}
<script>window.__VIZ=${JSON.stringify(viz || { gen: 1.2, reread: 92 })}</script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js" defer></script>
<script>${JS}
window.addEventListener('load',function(){${VIZ_JS}});</script></body></html>`;
}

const VIZ_CANVAS = `<canvas class="viz" aria-hidden="true"></canvas>`;

function pageHtml(focusId, demo = false, wantedHandle = null) {
  const { n, cols } = cohortValues();
  const counts = new Array(HIST_LABELS.length).fill(0);
  for (const v of cols.projectedUsd) counts[bucketOf(v)]++;
  const med = median(cols.projectedUsd);

  let d = null;
  if (demo) d = DEMO;
  else if (focusId) {
    const row = getRow.get(focusId);
    if (row) {
      const cmp = compareFor(row);
      d = {
        handle: row.handle || null, anomaly: row.anomalyRatio || 0,
        proj: row.projectedUsd, avgDaily: row.avgDailyUsd, gen: row.genPct, reread: row.rereadPct, opus: row.opusSharePct,
        spendPct: cmp.pct.projectedUsd ?? 50, genPct: cmp.pct.genPct ?? 50, rereadPct: cmp.pct.rereadPct ?? 50,
        opusPct: cmp.pct.opusSharePct ?? 50, dayPct: cmp.pct.avgDailyUsd ?? 50,
        cohort: cmp.cohort, medProj: cmp.median.projectedUsd, counts, youBucket: bucketOf(row.projectedUsd),
      };
    }
  }

  if (d) {
    const who = d.handle ? "@" + d.handle : "spend report";
    return shell({
      title: `${who} · ${$(d.proj)}/mo AI-coding burn · tokenrot`,
      ogDesc: `${Math.round(d.reread)}% of tokens re-read context, ${d.gen}% wrote code, Opus ${Math.round(d.opus)}% of the bill — ranked vs ${d.cohort.toLocaleString()} devs.`,
      path: demo ? "/demo" : d.handle ? "/@" + d.handle : "/",
      viz: { gen: d.gen, reread: d.reread },
      active: demo ? "demo" : "",
      body: cardBody(d, demo),
    });
  }
  const totalBurn = cols.projectedUsd.reduce((a, b) => a + b, 0);
  return shell({
    title: "tokenrot — the AI-spend leaderboard",
    ogDesc: n > 0 ? `${n.toLocaleString()} anonymous devs ranked by AI-coding burn. Median ${$(med)}/mo.` : "Find out what your AI coding actually costs — and where you rank. 100% local, anonymous.",
    path: "/",
    viz: { gen: median(cols.genPct) ?? 1.2, reread: median(cols.rereadPct) ?? 92 },
    active: "board",
    body: boardPage(n, med, counts, totalBurn, wantedHandle),
  });
}

function boardPage(n, med, counts, totalBurn, missing) {
  const empty = n === 0;
  const hero = `
  <section class="hero">${VIZ_CANVAS}
    <div class="hero-in">
      <span class="chip"><span class="dot"></span>The AI-spend leaderboard${empty ? "" : " · live"}</span>
      <h1 class="display">Your tokens are <em>rotting</em>.</h1>
      <p class="lede">Up to <b>96% of what you pay for</b> is the model re-reading context it already saw. One command reads your local logs — <b>nothing leaves your machine</b> — and shows the truth, then ranks you anonymously.</p>
      <div class="cmdrow">
        <div class="cmdbox"><span class="cmd"><span class="p">$</span> npx <span class="n">tokenrot</span></span>
          <button class="btn primary copy" type="button" aria-label="Copy the command npx tokenrot">copy</button></div>
        <a class="btn" href="https://github.com/MaximusStupidus/tokenrot" aria-label="View source on GitHub">view source</a>
      </div>
      <div class="herostats">
        <div class="hs"><div class="v num" data-n="${n}">${n.toLocaleString()}</div><div class="k">devs ranked</div></div>
        <div class="hs"><div class="v money num" ${med ? `data-n="${Math.round(med)}" data-fmt="usd"` : ""}>${med ? $(med) : "$—"}</div><div class="k">median burn / mo</div></div>
        <div class="hs"><div class="v money num" ${totalBurn ? `data-n="${Math.round(totalBurn)}" data-fmt="usd"` : ""}>${totalBurn ? $(totalBurn) : "$—"}</div><div class="k">cohort total / mo</div></div>
      </div>
    </div>
  </section>`;

  const boardSection = empty
    ? `
  <section class="sec"><div class="narrow">
    <div class="sec-head"><h2>The board</h2><span class="r">waiting for its first dev</span></div>
    <div class="panel">
      <div class="lb">${["feral-cachegoblin-73", "opus-pilled-tokensmith-9", "chaotic-looprunner-41", "stealth-contexthoarder-12"].map((h, i) => `
        <div class="lb-row ghost"><span class="lb-rank num">${i + 1}</span>
          <span class="lb-who"><span class="lb-handle">${h}</span><span class="lb-ago">—</span></span>
          <span class="lb-scale"><span class="ax"></span></span>
          <span class="lb-burn num">$&thinsp;—<i>/mo</i></span></div>`).join("")}</div>
      <div class="claim"><b>#1 is open.</b> Run <span class="num">npx tokenrot --compare</span> and own the top of the board under an anonymous handle.</div>
    </div>
  </div></section>`
    : `
  <section class="sec"><div class="narrow">
    <div class="sec-head"><h2>Rankings</h2><span class="r">top 100 · refreshes live</span></div>
    ${missing ? `<p style="font-family:var(--sans);color:var(--dim);font-size:13px;margin:0 0 14px">No dev named <b>@${missing}</b> on the board (yet) — here's everyone who is.</p>` : ""}
    <div class="panel">
      <div class="tabs" role="group" aria-label="Sort rankings">
        <button class="tab on" type="button" data-k="burn" aria-pressed="true">$ burn</button>
        <button class="tab" type="button" data-k="reread" aria-pressed="false">% re-read</button>
        <button class="tab" type="button" data-k="opus" aria-pressed="false">% opus</button>
      </div>
      <div class="lb">${boardRows()}</div>
      <div class="lab"><span>Spend distribution</span><span class="r num">${n.toLocaleString()} devs</span></div>
      <div class="dist">${histHtml(counts, -1)}</div>
    </div>
  </div></section>`;

  const how = `
  <section class="sec"><div class="container">
    <div class="sec-head"><h2>How it works</h2><span class="r">zero deps · open source</span></div>
    <div class="steps">
      <div class="step"><div class="g num">$</div><h3>Run it locally</h3><p><code>npx tokenrot</code> reads the usage logs Claude Code &amp; Codex already keep on your disk. No account, no upload, nothing leaves your machine.</p></div>
      <div class="step"><div class="g num">%</div><h3>See the truth</h3><p>API-equivalent cost of every token — live prices — plus the stat nobody expects: how little of your bill was the model actually <em>writing code</em>.</p></div>
      <div class="step"><div class="g num">@</div><h3>Rank &amp; share</h3><p><code>--compare</code> puts you on this board under a random handle, tells you how to cut the burn, and gives you a receipt worth posting.</p></div>
    </div>
  </div></section>`;

  const term = empty ? `
  <section class="sec tight"><div class="narrow">
    <div class="sec-head"><h2>What you'll see</h2><span class="r">real output</span></div>
    <div class="term"><span class="p">$</span> <span class="c">npx tokenrot</span>
<span class="d">Across</span> <span class="c">15,877</span> <span class="d">messages in</span> <span class="c">495</span> <span class="d">sessions, the model was actually</span>
<span class="d">writing code</span> <span class="a">0.93%</span> <span class="d">of the time.</span>
<span class="d">You've burned</span> <span class="a">$3,517</span> <span class="d">in API-equivalent value over 38 days.</span>
<span class="d">Re-reading old context</span> <span class="bar">████████████████████░░</span> <span class="c">91%</span>
<span class="d">Claude writing code</span>&nbsp;&nbsp;&nbsp;<span class="bar">░░░░░░░░░░░░░░░░░░░░░░</span> <span class="c">0.9%</span>
<span class="g">🔒 Local.</span> <span class="d">Nothing was uploaded. No account.</span></div>
  </div></section>` : "";

  return hero + boardSection + term + how;
}

function boardRows() {
  const rows = db.query("SELECT handle, projectedUsd, genPct, rereadPct, opusSharePct, updatedAt FROM subs WHERE handle IS NOT NULL ORDER BY projectedUsd DESC LIMIT 100").all();
  const maxBurn = Math.max(1, rows[0]?.projectedUsd || 1);
  return rows.map((r, i) => `
    <a class="lb-row${i < 3 ? " r" + (i + 1) : ""}" href="/@${r.handle}"
       data-burn="${r.projectedUsd}" data-reread="${r.rereadPct}" data-opus="${r.opusSharePct}">
      <span class="lb-rank num">${i + 1}</span>
      <span class="lb-who"><span class="lb-handle">${r.handle}</span><span class="lb-ago">${timeAgo(r.updatedAt)}</span></span>
      <span class="lb-scale"><span class="ax"></span><span class="fill" style="width:${Math.max(2, Math.round((r.projectedUsd / maxBurn) * 100))}%"></span></span>
      <span class="lb-burn num">${$(r.projectedUsd)}<i>/mo</i></span>
    </a>`).join("");
}

function cardBody(d, demo) {
  const hook = d.spendPct >= 55
    ? `Out-burns <b>${d.spendPct}% of developers.</b> See where you land.`
    : `Leaner than <b>${Math.max(1, 100 - d.spendPct)}% of developers.</b> See where you land.`;
  const mix = `<div class="mixbar"><i style="width:${d.opus}%;background:var(--accent)"></i><i style="width:${100 - d.opus}%;background:#39445a"></i></div>
    <div class="mixleg"><span><em style="background:var(--accent)"></em>Opus ${d.opus}%</span><span><em style="background:#39445a"></em>Everything else ${Math.round((100 - d.opus) * 10) / 10}%</span></div>`;
  return `
  <section class="sec tight"><div class="container">
    <div class="sheet">
      <div class="card-hero">${VIZ_CANVAS}
        <span class="chip"><span class="dot"></span>Spend report · ${d.handle ? "@" + d.handle : "anonymous"}${demo ? " · demo" : ""}</span>
        <h1 class="display" style="margin-top:16px"><span class="num">${$(d.proj)}</span><em>/mo</em> burn</h1>
        <p class="lede" style="font-size:13.5px">ranked against <b class="num">${d.cohort.toLocaleString()}</b> devs · median <span class="num">${$(d.medProj)}</span>/mo</p>
      </div>
      <div class="finds">${findingsHtml(d)}</div>
      <div class="lab"><span>Where this lands</span><span class="r">percentile vs cohort · ◆ median</span></div>
      <div class="meas">
        ${measRow("Monthly spend", $(d.proj), d.spendPct)}
        ${measRow("Tokens that were actual code", d.gen + "%", d.genPct)}
        ${measRow("Spent re-reading context", Math.round(d.reread) + "%", d.rereadPct)}
        ${measRow("Opus reliance", Math.round(d.opus) + "%", d.opusPct)}
        ${measRow("Burn per active day", $(d.avgDaily), d.dayPct)}
      </div>
      <div class="lab"><span>Model mix</span><span class="r">by cost</span></div>
      <div class="mix">${mix}</div>
      ${tipsHtml(d)}
      <div class="lab"><span>Cohort distribution</span><span class="r">projected / month</span></div>
      <div class="dist" style="padding:6px 24px 20px">${histHtml(d.counts, d.youBucket)}</div>
      <div class="card-cta">
        <span class="cmd"><span class="p">$</span> npx <span class="n">tokenrot</span></span>
        <div style="display:flex;gap:10px;align-items:center">
          <button class="btn primary copy" type="button" aria-label="Copy the command npx tokenrot">copy command</button>
          <span class="hook">${hook}</span>
        </div>
      </div>
    </div>
  </div></section>`;
}

console.log(`tokenrot compare server on :${PORT} (db ${DB_PATH})`);
