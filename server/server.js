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
  (id,handle,tool,plan,totalUsd,monthUsd,projectedUsd,avgDailyUsd,genPct,rereadPct,opusSharePct,anomalyRatio,spanDays,activeDays,tokTotal,tokOutput,tokCacheRead,updatedAt)
  VALUES ($id,$handle,$tool,$plan,$totalUsd,$monthUsd,$projectedUsd,$avgDailyUsd,$genPct,$rereadPct,$opusSharePct,$anomalyRatio,$spanDays,$activeDays,$tokTotal,$tokOutput,$tokCacheRead,$updatedAt)
  ON CONFLICT(id) DO UPDATE SET
    handle=COALESCE(subs.handle,$handle),
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
// Callers are read-only and must not mutate the returned arrays.
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
    const html = (s) => new Response(s, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (p === "/") return html(pageHtml(null)); // leaderboard (or empty-state)
    if (p.startsWith("/@")) {
      // PUBLIC share page, addressed by anonymous handle — the secret id never appears here
      const handle = decodeURIComponent(p.slice(2)).toLowerCase();
      const row = /^[a-z0-9-]{3,48}$/.test(handle) ? getByHandle().get(handle) : null;
      return html(pageHtml(row ? row.id : null));
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

function statsPayload() {
  const { n, cols } = cohortValues();
  const out = { cohort: n, median: {} };
  for (const m of METRICS) out.median[m] = round(median(cols[m]), m.endsWith("Usd") ? 0 : 1);
  return out;
}

const CSS = `
:root{--bg:#0a0c11;--panel:#121723;--panel2:#171d2b;--line:#232a3a;--line2:#2d3547;--txt:#e8ebf2;--dim:#8b93a4;--faint:#5c6376;--ember:#ff6a2b;--ember-soft:#ff8a54;--amber:#ffb347;--green:#43d17f;--red:#ff5a52;--cyan:#5ad1e0;--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;--sans:ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(1200px 600px at 50% -10%,#16233a 0,transparent 60%),radial-gradient(800px 500px at 90% 20%,#2a1508 0,transparent 55%),var(--bg);color:var(--txt);font-family:var(--sans);line-height:1.5;-webkit-font-smoothing:antialiased}
.wrap{max-width:660px;margin:0 auto;padding:34px 20px 60px}
.num{font-family:var(--mono);font-variant-numeric:tabular-nums}
.card{background:linear-gradient(180deg,#0e1420,#0b0f18);border:1px solid var(--line);border-radius:20px;overflow:hidden;box-shadow:0 40px 120px -40px rgba(0,0,0,.8),inset 0 1px 0 rgba(255,255,255,.03)}
.head{display:flex;align-items:center;justify-content:space-between;padding:16px 22px;border-bottom:1px solid var(--line);background:rgba(255,255,255,.015)}
.brand{display:flex;align-items:center;gap:9px;font-weight:800;letter-spacing:-.02em;font-size:16px}
.brand .dot{width:9px;height:9px;border-radius:50%;background:var(--ember);box-shadow:0 0 12px 1px var(--ember)}
.tool{font-size:12px;color:var(--dim)}
.hero{padding:34px 26px 26px;text-align:center}
.badge{display:inline-flex;align-items:baseline;gap:10px;padding:7px 16px;border-radius:999px;background:rgba(255,106,43,.12);border:1px solid rgba(255,106,43,.4);margin-bottom:18px}
.badge .b-lab{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--ember-soft);font-weight:700}
.badge .b-num{font-weight:800;color:var(--ember);font-size:14px}
.hero h1{margin:0;font-size:clamp(24px,5.6vw,34px);font-weight:800;letter-spacing:-.03em;text-wrap:balance;line-height:1.08}
.hero h1 em{font-style:normal;color:var(--amber)}
.hero .sub{margin:12px 0 0;color:var(--dim);font-size:14px}
.hero .sub b{color:var(--txt)}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--line);border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.tile{background:#0d121c;padding:18px 16px;display:flex;flex-direction:column;gap:5px;min-height:104px}
.tile .t-lab{font-size:10.5px;letter-spacing:.11em;text-transform:uppercase;color:var(--faint);font-weight:700}
.tile .t-num{font-size:26px;font-weight:700;letter-spacing:-.02em;line-height:1}
.tile .t-sub{font-size:11.5px;color:var(--dim);margin-top:auto}
.tile.money .t-num{color:var(--amber)}.tile.hot .t-num{color:var(--ember)}
@media(max-width:560px){.tiles{grid-template-columns:repeat(2,1fr)}}
.sec{padding:26px 26px 6px}
.sec-h{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:20px}
.sec-h h2{margin:0;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);font-weight:700}
.sec-h .note{font-size:11.5px;color:var(--faint)}
.rk{margin-bottom:22px}
.rk-top{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px}
.rk-top .l{font-size:13.5px;color:var(--txt);font-weight:600}.rk-top .r{display:flex;align-items:baseline;gap:10px}
.rk-top .v{font-size:14px;font-weight:700}
.tag{font-size:11px;font-weight:700;padding:2px 8px;border-radius:6px}
.tag.top{color:var(--ember);background:rgba(255,106,43,.13)}.tag.bot{color:var(--dim);background:rgba(255,255,255,.05)}
.track{position:relative;height:12px;border-radius:8px;background:linear-gradient(90deg,#1a2130,#242c3d 45%,#3a2a1c 78%,#4a2a12);box-shadow:inset 0 1px 2px rgba(0,0,0,.5)}
.track .med{position:absolute;top:-4px;bottom:-4px;width:2px;background:var(--faint);border-radius:2px;opacity:.8}
.track .med::after{content:"median";position:absolute;top:-16px;left:50%;transform:translateX(-50%);font-family:var(--mono);font-size:9px;color:var(--faint);white-space:nowrap}
.track .you{position:absolute;top:50%;width:16px;height:16px;border-radius:50%;background:var(--ember);border:2px solid #0b0f18;transform:translate(-50%,-50%);box-shadow:0 0 0 4px rgba(255,106,43,.22),0 0 16px 2px rgba(255,106,43,.6);z-index:2}
.mix{display:flex;height:30px;border-radius:9px;overflow:hidden;border:1px solid var(--line2)}
.mix span{display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:11px;font-weight:700;color:#0b0f18;min-width:0}
.mix .op{background:linear-gradient(180deg,#ff8a54,#ff6a2b)}.mix .ot{background:#2a3243}
.legend{display:flex;gap:18px;margin-top:12px;font-size:12px;color:var(--dim)}
.legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px;vertical-align:middle}
.hist{display:flex;flex-direction:column;gap:8px}
.hrow{display:flex;align-items:center;gap:12px}
.hrow .hl{width:78px;text-align:right;font-family:var(--mono);font-size:11.5px;color:var(--dim)}
.hrow .ht{flex:1;height:16px;background:#0d121c;border-radius:5px;overflow:hidden}
.hrow .hf{height:100%;background:#2b3444;border-radius:5px}
.hrow.you .hf{background:linear-gradient(90deg,#ff6a2b,#ff8a54);box-shadow:0 0 14px rgba(255,106,43,.5)}
.hrow .hc{width:56px;font-family:var(--mono);font-size:11.5px;color:var(--faint)}.hrow.you .hc{color:var(--ember);font-weight:700}
.foot{margin-top:14px;padding:18px 26px 22px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:13px;background:linear-gradient(90deg,rgba(255,106,43,.06),rgba(255,106,43,0) 70%)}
.nudge-hook{font-size:15px;color:var(--txt);font-weight:600;letter-spacing:-.01em;line-height:1.35}
.nudge-hook b{color:var(--amber)}.nudge-hook .send{color:var(--ember);font-weight:700;white-space:nowrap}
.foot-cta{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}
.cmd{font-family:var(--mono);font-size:15px;font-weight:700;background:#0d121c;border:1px solid var(--line2);border-radius:9px;padding:10px 15px;color:var(--txt)}.cmd b{color:var(--ember)}
.priv{font-size:11.5px;color:var(--faint);max-width:340px}.priv b{color:var(--green)}
.lb{display:flex;flex-direction:column;padding:10px 14px 4px}
.lb-row{display:flex;align-items:center;gap:14px;padding:11px 12px;border-radius:10px;text-decoration:none;color:var(--txt);border:1px solid transparent}
.lb-row:hover{background:#12182466;border-color:var(--line)}
.lb-row.first{background:linear-gradient(90deg,rgba(255,106,43,.10),transparent 75%);border-color:rgba(255,106,43,.35)}
.lb-rank{width:28px;text-align:right;color:var(--faint);font-size:13px}
.lb-row.first .lb-rank{color:var(--ember);font-weight:800}
.lb-handle{flex:1;font-family:var(--mono);font-size:13.5px;font-weight:600;color:var(--txt);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lb-burn{font-weight:800;color:var(--amber);font-size:14px}.lb-burn i{font-style:normal;color:var(--faint);font-size:11px;font-weight:400}
.lb-mini{color:var(--dim);font-size:11px;width:74px;text-align:right}
@media(max-width:560px){.lb-mini{display:none}}
.anim{opacity:0;transform:translateY(10px);animation:rise .6s cubic-bezier(.16,1,.3,1) forwards}
@keyframes rise{to{opacity:1;transform:none}}
@media(prefers-reduced-motion:reduce){.anim{animation:none;opacity:1;transform:none}}
`;
const HIST_LABELS = ["<$100", "$100–300", "$300–600", "$600–1k", "$1k–2k", "$2k–5k", "$5k+"];
const HIST_EDGES = [0, 100, 300, 600, 1000, 2000, 5000, 1e9];
const DEMO = { proj: 9240, avgDaily: 304, gen: 0.5, reread: 96, opus: 97, spendPct: 92, genPct: 12, rereadPct: 91, opusPct: 96, dayPct: 93, cohort: 1284, medProj: 3808, counts: [34, 62, 100, 58, 36, 20, 11], youBucket: 6 };

const $ = (n) => "$" + Math.round(n).toLocaleString("en-US");
const bucketOf = (v) => { for (let i = 0; i < HIST_LABELS.length; i++) if (v < HIST_EDGES[i + 1]) return i; return HIST_LABELS.length - 1; };

function rankTrack(label, valStr, pct) {
  const top = 100 - pct;
  const tag = pct >= 50 ? `<span class="tag top num">top ${Math.max(1, top)}%</span>` : `<span class="tag bot num">bottom ${Math.max(1, pct)}%</span>`;
  return `<div class="rk"><div class="rk-top"><span class="l">${label}</span><span class="r"><span class="v num">${valStr}</span>${tag}</span></div>
    <div class="track"><div class="med" style="left:50%"></div><div class="you" style="left:${Math.max(3, Math.min(97, pct))}%"></div></div></div>`;
}
function histHtml(counts, youBucket) {
  const maxc = Math.max(1, ...counts);
  return HIST_LABELS.map((lb, i) => `<div class="hrow${i === youBucket ? " you" : ""}"><span class="hl">${lb}</span>
    <span class="ht"><span class="hf" style="width:${Math.round((counts[i] / maxc) * 100)}%"></span></span>
    <span class="hc">${i === youBucket ? "you" : counts[i]}</span></div>`).join("");
}

function pageHtml(focusId, demo = false) {
  const { n, cols } = cohortValues();
  const counts = new Array(HIST_LABELS.length).fill(0);
  for (const v of cols.projectedUsd) counts[bucketOf(v)]++;
  const med = median(cols.projectedUsd);

  let d = null; // per-user data
  if (demo) d = DEMO;
  else if (focusId) {
    const row = getRow.get(focusId);
    if (row) {
      const cmp = compareFor(row);
      d = {
        handle: row.handle || null,
        proj: row.projectedUsd, avgDaily: row.avgDailyUsd, gen: row.genPct, reread: row.rereadPct, opus: row.opusSharePct,
        spendPct: cmp.pct.projectedUsd ?? 50, genPct: cmp.pct.genPct ?? 50, rereadPct: cmp.pct.rereadPct ?? 50,
        opusPct: cmp.pct.opusSharePct ?? 50, dayPct: cmp.pct.avgDailyUsd ?? 50,
        cohort: cmp.cohort, medProj: cmp.median.projectedUsd, counts, youBucket: bucketOf(row.projectedUsd),
      };
    }
  }

  const body = d ? youBody(d, demo) : n > 0 ? boardBody(n, med, counts) : crowdBody(n, med, counts);
  const hook = d
    ? (d.spendPct >= 55
        ? `You out-burn <b>${d.spendPct}% of developers.</b> Most have no idea what their AI coding costs.`
        : `You're leaner than <b>${Math.max(1, 100 - d.spendPct)}% of developers.</b> Quietly winning.`)
    : `See where your AI-coding spend really ranks.`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>tokenrot — your AI-coding spend, ranked</title>
<meta property="og:title" content="tokenrot — your AI-coding spend, ranked"/>
<meta name="theme-color" content="#0a0c11"/>
<style>${CSS}</style></head><body><div class="wrap"><div class="card">${body}
<div class="foot"><div class="nudge-hook">${hook} <span class="send">Send them the receipt →</span></div>
<div class="foot-cta"><span class="cmd"><b>npx</b> tokenrot</span>
<span class="priv">anonymous · nothing leaves your machine · <span class="num">tokenrot --forget</span> to delete</span></div></div>
</div></div></body></html>`;
}

// The public leaderboard — anonymous handles only, ranked by projected burn.
function boardBody(n, med, counts) {
  const rows = db.query("SELECT handle, projectedUsd, genPct, rereadPct, opusSharePct FROM subs WHERE handle IS NOT NULL ORDER BY projectedUsd DESC LIMIT 100").all();
  const tr = rows.map((r, i) => `
    <a class="lb-row${i === 0 ? " first" : ""}" href="/@${r.handle}">
      <span class="lb-rank num">${i + 1}</span>
      <span class="lb-handle">${r.handle}</span>
      <span class="lb-burn num">${$(r.projectedUsd)}<i>/mo</i></span>
      <span class="lb-mini num">${r.genPct}% code</span>
      <span class="lb-mini num">${Math.round(r.rereadPct)}% re-read</span>
      <span class="lb-mini num">${Math.round(r.opusSharePct)}% opus</span>
    </a>`).join("");
  return `
  <div class="head"><span class="brand"><span class="dot"></span>tokenrot</span><span class="tool">the AI-spend leaderboard</span></div>
  <div class="hero anim"><h1>Who's burning the most<br/>on AI coding?</h1>
    <p class="sub"><b class="num">${n.toLocaleString()}</b> anonymous devs · median <b class="num">${med ? $(med) : "—"}</b>/mo projected · run <span class="num">npx tokenrot</span> to join</p></div>
  <div class="lb anim" style="animation-delay:.08s">${tr}</div>
  <div class="sec anim" style="animation-delay:.15s"><div class="sec-h"><h2>Spend distribution</h2><span class="note num">${n.toLocaleString()} devs</span></div>
    <div class="hist">${histHtml(counts, -1)}</div></div>`;
}

function youBody(d, demo) {
  const mix = `<div class="mix"><span class="op" style="width:${d.opus}%">Opus ${d.opus}%</span><span class="ot" style="width:${100 - d.opus}%"></span></div>
    <div class="legend"><span><i style="background:#ff6a2b"></i>Opus ${d.opus}%</span><span><i style="background:#2a3243"></i>Everything else ${100 - d.opus}%</span></div>`;
  return `
  <div class="head"><span class="brand"><span class="dot"></span>tokenrot</span><span class="tool num">${d.handle ? "@" + d.handle : "Claude Code"}${demo ? " · demo" : ""}</span></div>
  <div class="hero anim"><span class="badge"><span class="b-lab">Spender rank</span><span class="b-num num">TOP ${Math.max(1, 100 - d.spendPct)}%</span></span>
    <h1>You out-spend <em>${d.spendPct}%</em> of developers.</h1>
    <p class="sub">Ranked against <b class="num">${d.cohort.toLocaleString()}</b> devs running <span class="num">tokenrot --compare</span></p></div>
  <div class="tiles anim" style="animation-delay:.05s">
    <div class="tile money"><span class="t-lab">Proj / month</span><span class="t-num num">${$(d.proj)}</span><span class="t-sub num">median ${$(d.medProj)}</span></div>
    <div class="tile hot"><span class="t-lab">Writing code</span><span class="t-num num">${d.gen}%</span><span class="t-sub">of your tokens</span></div>
    <div class="tile"><span class="t-lab">Re-reading</span><span class="t-num num">${d.reread}%</span><span class="t-sub">of your tokens</span></div>
    <div class="tile"><span class="t-lab">Opus share</span><span class="t-num num">${d.opus}%</span><span class="t-sub">of your bill</span></div></div>
  <div class="sec anim" style="animation-delay:.1s"><div class="sec-h"><h2>Where you land</h2><span class="note">◄ less · more ►</span></div>
    ${rankTrack("Monthly spend", $(d.proj), d.spendPct)}
    ${rankTrack("Tokens that were actual code", d.gen + "%", d.genPct)}
    ${rankTrack("Spent re-reading context", d.reread + "%", d.rereadPct)}
    ${rankTrack("Opus reliance", d.opus + "%", d.opusPct)}
    ${rankTrack("Burn per active day", $(d.avgDaily), d.dayPct)}</div>
  <div class="sec anim" style="animation-delay:.15s"><div class="sec-h"><h2>Your model mix</h2><span class="note">by cost</span></div>${mix}</div>
  <div class="sec anim" style="animation-delay:.2s"><div class="sec-h"><h2>Monthly spend across everyone</h2><span class="note num">${d.cohort.toLocaleString()} devs</span></div>
    <div class="hist">${histHtml(d.counts, d.youBucket)}</div></div>`;
}

function crowdBody(n, med, counts) {
  if (n === 0) return `
  <div class="head"><span class="brand"><span class="dot"></span>tokenrot</span><span class="tool">the AI-spend index</span></div>
  <div class="hero anim"><h1>See where your AI-coding<br/>spend really <em>ranks</em>.</h1>
    <p class="sub">Run one command locally — nothing leaves your machine — then compare, 100% anonymously.</p></div>
  <div class="sec anim" style="animation-delay:.1s"><div class="sec-h"><h2>Try it</h2></div>
    <p style="color:var(--dim);font-size:14px;margin:0">The model is only "writing" a fraction of a percent of your tokens.
    See your real number, and how it stacks up: <span class="num" style="color:var(--cyan)">npx tokenrot --compare</span></p></div>`;
  return `
  <div class="head"><span class="brand"><span class="dot"></span>tokenrot</span><span class="tool">the AI-spend index</span></div>
  <div class="hero anim"><h1>How <em>${n.toLocaleString()}</em> developers spend on AI coding.</h1>
    <p class="sub">Anonymous, self-reported from devs running <span class="num">tokenrot --compare</span></p></div>
  <div class="tiles anim" style="animation-delay:.05s">
    <div class="tile"><span class="t-lab">Developers</span><span class="t-num num">${n.toLocaleString()}</span><span class="t-sub">compared</span></div>
    <div class="tile money"><span class="t-lab">Median / month</span><span class="t-num num">${med ? $(med) : "—"}</span><span class="t-sub">projected</span></div>
    <div class="tile hot"><span class="t-lab">The catch</span><span class="t-num num">&lt;1%</span><span class="t-sub">of tokens write code</span></div>
    <div class="tile"><span class="t-lab">Mostly</span><span class="t-num num">Opus</span><span class="t-sub">+ re-reading</span></div></div>
  <div class="sec anim" style="animation-delay:.15s"><div class="sec-h"><h2>Projected monthly spend — distribution</h2><span class="note num">${n.toLocaleString()} devs</span></div>
    <div class="hist">${histHtml(counts, -1)}</div></div>`;
}

console.log(`tokenrot compare server on :${PORT} (db ${DB_PATH})`);
