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
   PRESENTATION — "precision instrument" design language.
   Monospace voice, tabular numbers, hairline rules, one muted ember accent
   reserved for data. No glow, no gradients, no decoration without meaning.
   ══════════════════════════════════════════════════════════════════════ */

const CSS = `
:root{
  --bg:#0a0c10;--surface:#0e1118;--raise:#12161f;--line:#1c222c;--hair:#161b23;
  --ink:#c9ced7;--ink2:#eef1f6;--dim:#727a86;--faint:#464d58;
  --accent:#d5813c;--accent-dim:#7a5230;--green:#6aa588;--red:#c96a5f;
  --mono:"SF Mono",SFMono-Regular,ui-monospace,Menlo,Consolas,"Liberation Mono",monospace;
  --sans:ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--mono);font-size:13px;line-height:1.55;
  -webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
a{color:inherit;text-decoration:none}
.wrap{max-width:680px;margin:0 auto;padding:36px 18px 56px}
.sheet{background:var(--surface);border:1px solid var(--line);border-radius:8px;overflow:hidden}
.num{font-variant-numeric:tabular-nums}
b{font-weight:600;color:var(--ink2)}
.q{color:var(--dim)}

/* header — instrument stamp */
.top{display:flex;justify-content:space-between;align-items:center;padding:13px 18px;border-bottom:1px solid var(--line)}
.top .id{letter-spacing:.34em;font-weight:600;color:var(--ink2);font-size:12px}
.top .id b{color:var(--accent)}
.top .meta{font-size:11px;color:var(--dim);display:flex;align-items:center;gap:8px}
.top .live{width:6px;height:6px;border-radius:50%;background:var(--green)}

/* hero */
.hero{padding:26px 18px 22px;border-bottom:1px solid var(--hair)}
.kicker{font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--faint);margin-bottom:8px}
.hero h1{font-family:var(--sans);font-size:clamp(21px,4.6vw,27px);font-weight:800;letter-spacing:-.025em;
  margin:0;color:var(--ink2);line-height:1.15;text-wrap:balance}
.hero h1 em{font-style:normal;color:var(--accent)}
.hero .sub{margin:9px 0 0;color:var(--dim);font-size:12.5px}

/* stats strip */
.strip{display:grid;grid-template-columns:repeat(3,1fr);border-bottom:1px solid var(--hair)}
.cell{padding:15px 18px;border-right:1px solid var(--hair)}
.cell:last-child{border-right:0}
.cell .k{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--faint)}
.cell .v{font-size:21px;font-weight:600;color:var(--ink2);letter-spacing:-.02em;margin-top:3px}
.cell .v.money{color:var(--accent)}
.cell .s{font-size:10.5px;color:var(--faint);margin-top:1px}

/* section labels */
.lab{padding:16px 18px 8px;font-size:10.5px;letter-spacing:.18em;text-transform:uppercase;color:var(--faint);
  display:flex;justify-content:space-between;align-items:baseline}
.lab .r{letter-spacing:.02em;text-transform:none}

/* sort tabs */
.tabs{display:flex;gap:2px;padding:0 18px 10px}
.tab{font-family:var(--mono);font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);
  background:none;border:1px solid var(--hair);border-radius:5px;padding:4px 10px;cursor:pointer}
.tab:hover{color:var(--ink);border-color:var(--line)}
.tab.on{color:var(--accent);border-color:var(--accent-dim)}

/* leaderboard */
.lb{padding:2px 10px 14px}
.lb-row{display:grid;grid-template-columns:30px minmax(0,1fr) 96px 120px;gap:10px;align-items:center;
  padding:9px 8px;border-radius:6px;transition:background .12s}
.lb-row:hover{background:var(--raise)}
.lb-rank{text-align:right;color:var(--faint);font-size:12px}
.lb-row.r1 .lb-rank,.lb-row.r2 .lb-rank,.lb-row.r3 .lb-rank{color:var(--accent);font-weight:700}
.lb-who{min-width:0}
.lb-handle{font-size:13px;font-weight:600;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}
.lb-row:hover .lb-handle{color:var(--ink2)}
.lb-ago{font-size:10px;color:var(--faint)}
.lb-burn{text-align:right;font-weight:700;color:var(--accent);font-size:13.5px}
.lb-burn i{font-style:normal;color:var(--faint);font-size:10px;font-weight:400}
.lb-scale{position:relative;height:20px}
.lb-scale .ax{position:absolute;top:10px;left:0;right:0;height:1px;background:var(--hair)}
.lb-scale .fill{position:absolute;top:9px;left:0;height:3px;background:var(--accent-dim);border-radius:2px}
.lb-row.r1 .lb-scale .fill{background:var(--accent)}
@media(max-width:540px){.lb-row{grid-template-columns:26px minmax(0,1fr) 90px}.lb-scale{display:none}}

/* findings (card pages) */
.finds{padding:4px 18px}
.f{display:grid;grid-template-columns:74px 1fr;gap:15px;align-items:baseline;padding:14px 0;border-bottom:1px solid var(--hair)}
.f:last-child{border-bottom:0}
.f .fm{font-size:24px;font-weight:600;letter-spacing:-.02em;color:var(--accent);line-height:1;text-align:right}
.f .ft{font-family:var(--sans);font-size:14px;line-height:1.5;color:var(--ink)}

/* measurement scales */
.meas{padding:0 18px 8px}
.m{padding:11px 0;border-bottom:1px solid var(--hair)}
.m:last-child{border-bottom:0}
.m .mh{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px}
.m .name{color:var(--ink);font-size:12px}
.m .vals{display:flex;gap:12px;align-items:baseline}
.m .v{color:var(--ink2);font-weight:600;font-size:12.5px}
.m .pc{color:var(--dim);font-size:11px;width:66px;text-align:right}
.m .pc b{color:var(--accent)}
.scale{position:relative;height:20px}
.scale .axis{position:absolute;top:10px;left:0;right:0;height:1px;background:var(--line)}
.scale .tick{position:absolute;top:6px;width:1px;height:5px;background:var(--hair)}
.scale .med{position:absolute;top:5px;width:7px;height:7px;background:var(--surface);border:1px solid var(--dim);transform:translate(-50%,0) rotate(45deg)}
.scale .you{position:absolute;top:10px;transform:translateX(-50%)}
.scale .you .cap{position:absolute;left:50%;top:-4px;transform:translateX(-50%);width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:7px solid var(--accent)}
.scale .you .stem{position:absolute;left:50%;top:2px;transform:translateX(-50%);width:1px;height:8px;background:var(--accent)}

/* model mix */
.mix{padding:2px 18px 16px}
.mixbar{display:flex;height:8px;border-radius:2px;overflow:hidden;background:var(--raise)}
.mixbar i{display:block;height:100%}
.mixleg{display:flex;gap:20px;margin-top:10px;font-size:11px;color:var(--dim)}
.mixleg em{font-style:normal;display:inline-block;width:8px;height:8px;border-radius:1px;margin-right:6px;vertical-align:middle}

/* tips */
.tips{padding:2px 18px 14px}
.tip{padding:10px 0;border-bottom:1px solid var(--hair)}
.tip:last-child{border-bottom:0}
.tip .th{font-family:var(--sans);font-size:13.5px;color:var(--ink2);font-weight:600}
.tip .th s{text-decoration:none;color:var(--green)}
.tip .ts{font-family:var(--sans);font-size:12px;color:var(--dim);margin-top:2px}

/* histogram */
.dist{padding:2px 18px 16px}
.d{display:flex;align-items:center;gap:12px;padding:3px 0}
.d .dl{width:72px;text-align:right;color:var(--dim);font-size:11px}
.d .dt{flex:1;height:8px;background:var(--raise);border-radius:2px;overflow:hidden}
.d .df{height:100%;background:#2b323f}
.d.you .df{background:var(--accent)}
.d .dc{width:40px;color:var(--faint);font-size:11px}
.d.you .dc{color:var(--accent)}

/* terminal demo (empty state) */
.term{margin:14px 18px 4px;background:#07090d;border:1px solid var(--line);border-radius:7px;padding:14px 16px;
  font-size:12px;line-height:1.75;overflow-x:auto}
.term .p{color:var(--faint)} .term .c{color:var(--ink2)} .term .a{color:var(--accent)} .term .g{color:var(--green)} .term .d{color:var(--dim)}
.term .bar{color:var(--accent-dim)}

/* ghost rows (empty board) */
.ghost{opacity:.32;pointer-events:none}
.claim{margin:6px 18px 14px;border:1px dashed var(--accent-dim);border-radius:7px;padding:12px 16px;
  font-family:var(--sans);font-size:13px;color:var(--ink)}
.claim b{color:var(--accent)}

/* cta + copy */
.cta{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;
  padding:16px 18px;border-top:1px solid var(--line)}
.cmdline{display:flex;align-items:center;gap:10px}
.cmd{font-size:14.5px;font-weight:700;color:var(--ink2)}
.cmd .p{color:var(--faint);font-weight:400}.cmd .n{color:var(--accent)}
.copy{font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);
  background:var(--raise);border:1px solid var(--line);border-radius:5px;padding:4px 9px;cursor:pointer}
.copy:hover{color:var(--ink2);border-color:var(--accent-dim)}
.copy:focus-visible{outline:1px solid var(--accent)}
.hook{font-family:var(--sans);font-size:12.5px;color:var(--dim);max-width:34ch;text-align:right}
.hook b{color:var(--ink2)}

/* trust footer */
.trust{display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;padding:13px 18px;
  border-top:1px solid var(--hair);font-size:10.5px;color:var(--faint)}
.trust a{color:var(--dim);border-bottom:1px solid var(--hair)}
.trust a:hover{color:var(--ink)}
.trust .g{color:var(--green)}

@media(prefers-reduced-motion:reduce){*{transition:none!important}}
`;

const JS = `
(function(){
  var rm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // count-up on data-n numbers
  if (!rm) document.querySelectorAll('[data-n]').forEach(function(el){
    var t = +el.getAttribute('data-n'); if (!isFinite(t)) return;
    var usd = el.getAttribute('data-fmt') === 'usd'; var s = performance.now();
    (function f(now){ var p = Math.min(1,(now-s)/850); var v = t*(1-Math.pow(1-p,3));
      el.textContent = (usd?'$':'') + Math.round(v).toLocaleString('en-US'); if (p<1) requestAnimationFrame(f); })(s);
  });
  // copy npx command
  document.querySelectorAll('.copy').forEach(function(b){
    b.addEventListener('click', function(){
      navigator.clipboard.writeText('npx tokenrot').then(function(){
        b.textContent='copied'; setTimeout(function(){ b.textContent='copy'; },1200);
      }).catch(function(){});
    });
  });
  // sort tabs
  var lb = document.querySelector('.lb');
  document.querySelectorAll('.tab').forEach(function(tab){
    tab.addEventListener('click', function(){
      document.querySelectorAll('.tab').forEach(function(t){ t.classList.remove('on'); });
      tab.classList.add('on');
      var k = tab.getAttribute('data-k');
      var rows = Array.from(lb.querySelectorAll('.lb-row'));
      rows.sort(function(a,b){ return (+b.getAttribute('data-'+k)||0) - (+a.getAttribute('data-'+k)||0); });
      rows.forEach(function(r,i){ r.querySelector('.lb-rank').textContent = i+1;
        r.classList.remove('r1','r2','r3'); if (i<3) r.classList.add('r'+(i+1)); lb.appendChild(r); });
    });
  });
  // live board refresh (60s, only when visible, only on the board page)
  if (lb && location.pathname === '/') setInterval(function(){
    if (document.hidden) return;
    fetch(location.href).then(function(r){ return r.text(); }).then(function(t){
      var doc = new DOMParser().parseFromString(t,'text/html');
      var nb = doc.querySelector('.lb'); if (nb) lb.innerHTML = nb.innerHTML;
    }).catch(function(){});
  }, 60000);
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

function scaleHtml(pct) {
  const x = Math.max(3, Math.min(97, pct));
  return `<div class="scale"><div class="axis"></div>
    <div class="tick" style="left:25%"></div><div class="tick" style="left:50%"></div><div class="tick" style="left:75%"></div>
    <div class="med" style="left:50%"></div><div class="you" style="left:${x}%"><span class="cap"></span><span class="stem"></span></div></div>`;
}
function measRow(name, val, pct) {
  if (pct == null) return "";
  const top = 100 - pct;
  const tag = pct >= 50 ? `<b>${ord(Math.min(99, pct))}</b> pctl` : `${ord(Math.max(1, pct))} pctl`;
  return `<div class="m"><div class="mh"><span class="name">${name}</span><span class="vals"><span class="v num">${val}</span><span class="pc num">${tag}</span></span></div>${scaleHtml(pct)}</div>`;
}
const ord = (n) => n + (n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th");

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

function shell({ title, ogDesc, body, metaRight }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<meta property="og:title" content="${title}"/>
<meta property="og:description" content="${ogDesc}"/>
<meta name="description" content="${ogDesc}"/>
<meta name="theme-color" content="#0a0c10"/>
<style>${CSS}</style></head><body><div class="wrap"><div class="sheet">
<div class="top"><a class="id" href="/">TOKEN<b>ROT</b></a><span class="meta">${metaRight}</span></div>
${body}
<div class="trust"><span><span class="g">●</span> local-first · anonymous · no accounts · no IPs stored</span>
<span><a href="https://github.com/MaximusStupidus/tokenrot">source</a> · <a href="/prices">live prices</a> · <a href="https://github.com/MaximusStupidus/tokenrot/blob/main/docs/PRIVACY.md">privacy</a></span></div>
</div></div><script>${JS}</script></body></html>`;
}

const ctaHtml = (hook) => `
<div class="cta">
  <div class="cmdline"><span class="cmd"><span class="p">$</span> npx <span class="n">tokenrot</span></span><button class="copy" type="button">copy</button></div>
  <div class="hook">${hook}</div>
</div>`;

function pageHtml(focusId, demo = false, wantedHandle = null) {
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
    const hook = d.spendPct >= 55
      ? `Out-burns <b>${d.spendPct}% of developers.</b> See where you land.`
      : `Leaner than <b>${Math.max(1, 100 - d.spendPct)}% of developers.</b> See where you land.`;
    return shell({
      title: `${who} · ${$(d.proj)}/mo AI-coding burn · tokenrot`,
      ogDesc: `${Math.round(d.reread)}% of tokens re-read context, ${d.gen}% wrote code, Opus ${Math.round(d.opus)}% of the bill — ranked vs ${d.cohort.toLocaleString()} devs.`,
      metaRight: `${demo ? "demo · " : ""}<span class="num">${d.cohort.toLocaleString()}</span>&nbsp;devs on the board`,
      body: youBody(d) + ctaHtml(hook),
    });
  }
  // wanted a handle that doesn't exist → fall through to board with a note
  const totalBurn = cols.projectedUsd.reduce((a, b) => a + b, 0);
  return shell({
    title: "tokenrot — the AI-spend leaderboard",
    ogDesc: n > 0 ? `${n.toLocaleString()} anonymous devs ranked by AI-coding burn. Median ${$(med)}/mo.` : "Find out what your AI coding actually costs — and where you rank. 100% local, anonymous.",
    metaRight: `<span class="live"></span> <span class="num" data-n="${n}">${n.toLocaleString()}</span>&nbsp;devs`,
    body: (n > 0 ? boardBody(n, med, counts, totalBurn, wantedHandle) : emptyBody()) + ctaHtml(`Anonymous handle, public rank, <b>zero code leaves your machine.</b>`),
  });
}

function boardBody(n, med, counts, totalBurn, missing) {
  const rows = db.query("SELECT handle, projectedUsd, genPct, rereadPct, opusSharePct, updatedAt FROM subs WHERE handle IS NOT NULL ORDER BY projectedUsd DESC LIMIT 100").all();
  const maxBurn = Math.max(1, rows[0]?.projectedUsd || 1);
  const tr = rows.map((r, i) => `
    <a class="lb-row${i < 3 ? " r" + (i + 1) : ""}" href="/@${r.handle}"
       data-burn="${r.projectedUsd}" data-reread="${r.rereadPct}" data-opus="${r.opusSharePct}">
      <span class="lb-rank num">${i + 1}</span>
      <span class="lb-who"><span class="lb-handle">${r.handle}</span><span class="lb-ago">${timeAgo(r.updatedAt)}</span></span>
      <span class="lb-scale"><span class="ax"></span><span class="fill" style="width:${Math.max(2, Math.round((r.projectedUsd / maxBurn) * 100))}%"></span></span>
      <span class="lb-burn num">${$(r.projectedUsd)}<i>/mo</i></span>
    </a>`).join("");
  return `
  <div class="hero"><div class="kicker">The AI-spend leaderboard</div>
    <h1>Who's burning the most<br/>on AI coding?</h1>
    ${missing ? `<p class="sub">No dev named <b>@${missing}</b> on the board (yet) — here's everyone who is.</p>` : ""}
  </div>
  <div class="strip">
    <div class="cell"><div class="k">Devs ranked</div><div class="v num" data-n="${n}">${n.toLocaleString()}</div><div class="s">anonymous handles</div></div>
    <div class="cell"><div class="k">Median burn</div><div class="v money num" data-n="${Math.round(med || 0)}" data-fmt="usd">${$(med)}</div><div class="s">projected / month</div></div>
    <div class="cell"><div class="k">Cohort total</div><div class="v money num" data-n="${Math.round(totalBurn)}" data-fmt="usd">${$(totalBurn)}</div><div class="s">API-equivalent / month</div></div>
  </div>
  <div class="lab"><span>Rankings</span><span class="r">top 100 · live</span></div>
  <div class="tabs">
    <button class="tab on" type="button" data-k="burn">$ burn</button>
    <button class="tab" type="button" data-k="reread">% re-read</button>
    <button class="tab" type="button" data-k="opus">% opus</button>
  </div>
  <div class="lb">${tr}</div>
  <div class="lab"><span>Spend distribution</span><span class="r num">${n.toLocaleString()} devs</span></div>
  <div class="dist">${histHtml(counts, -1)}</div>`;
}

function emptyBody() {
  const ghosts = ["feral-cachegoblin-73", "opus-pilled-tokensmith-9", "chaotic-looprunner-41", "stealth-contexthoarder-12"]
    .map((h, i) => `<div class="lb-row ghost"><span class="lb-rank num">${i + 1}</span>
      <span class="lb-who"><span class="lb-handle">${h}</span><span class="lb-ago">—</span></span>
      <span class="lb-scale"><span class="ax"></span></span>
      <span class="lb-burn num">$&thinsp;—<i>/mo</i></span></div>`).join("");
  return `
  <div class="hero"><div class="kicker">The AI-spend leaderboard</div>
    <h1>What does your AI coding<br/><em>actually</em> cost?</h1>
    <p class="sub">One command. Reads your local logs — nothing leaves your machine — then shows the truth.</p>
  </div>
  <div class="term"><span class="p">$</span> <span class="c">npx tokenrot</span>
<span class="d">Across</span> <span class="c">15,877</span> <span class="d">messages in</span> <span class="c">495</span> <span class="d">sessions, the model was actually</span>
<span class="d">writing code</span> <span class="a">0.93%</span> <span class="d">of the time.</span>
<span class="d">You've burned</span> <span class="a">$3,517</span> <span class="d">in API-equivalent value over 38 days.</span>
<span class="d">Re-reading old context</span> <span class="bar">████████████████████░░</span> <span class="c">91%</span>
<span class="d">Claude writing code</span>&nbsp;&nbsp;&nbsp;<span class="bar">░░░░░░░░░░░░░░░░░░░░░░</span> <span class="c">0.9%</span>
<span class="g">🔒 Local.</span> <span class="d">Nothing was uploaded. No account.</span></div>
  <div class="lab"><span>The board</span><span class="r">waiting for its first dev</span></div>
  <div class="lb">${ghosts}</div>
  <div class="claim"><b>#1 is open.</b> Run <span class="num">npx tokenrot --compare</span> and own the top of the board under an anonymous handle.</div>`;
}

function youBody(d) {
  const mix = `<div class="mixbar"><i style="width:${d.opus}%;background:var(--accent)"></i><i style="width:${100 - d.opus}%;background:#2b323f"></i></div>
    <div class="mixleg"><span><em style="background:var(--accent)"></em>Opus ${d.opus}%</span><span><em style="background:#2b323f"></em>Everything else ${Math.round((100 - d.opus) * 10) / 10}%</span></div>`;
  return `
  <div class="hero"><div class="kicker">Spend report · ${d.handle ? "@" + d.handle : "anonymous"}</div>
    <h1><span class="num">${$(d.proj)}</span><em>/mo</em> projected burn</h1>
    <p class="sub">ranked against <b class="num">${d.cohort.toLocaleString()}</b> devs · median <span class="num">${$(d.medProj)}</span>/mo</p></div>
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
  <div class="dist">${histHtml(d.counts, d.youBucket)}</div>`;
}

console.log(`tokenrot compare server on :${PORT} (db ${DB_PATH})`);
