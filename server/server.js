// vibeaudit compare server — Bun + bun:sqlite, zero external deps.
// Stores only anonymous aggregate numbers. No accounts. No IP logging.
import { Database } from "bun:sqlite";

const PORT = Number(process.env.PORT || 7200);
const DB_PATH = process.env.VIBEAUDIT_DB || "./vibeaudit.db";
const BASE = process.env.PUBLIC_BASE || "https://vibeaudit.comsync.in";

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`CREATE TABLE IF NOT EXISTS subs (
  id TEXT PRIMARY KEY,
  tool TEXT, plan REAL,
  totalUsd REAL, monthUsd REAL, projectedUsd REAL, avgDailyUsd REAL,
  genPct REAL, rereadPct REAL, opusSharePct REAL, anomalyRatio REAL,
  spanDays INTEGER, activeDays INTEGER,
  tokTotal REAL, tokOutput REAL, tokCacheRead REAL,
  updatedAt INTEGER
);`);

const upsert = db.prepare(`INSERT INTO subs
  (id,tool,plan,totalUsd,monthUsd,projectedUsd,avgDailyUsd,genPct,rereadPct,opusSharePct,anomalyRatio,spanDays,activeDays,tokTotal,tokOutput,tokCacheRead,updatedAt)
  VALUES ($id,$tool,$plan,$totalUsd,$monthUsd,$projectedUsd,$avgDailyUsd,$genPct,$rereadPct,$opusSharePct,$anomalyRatio,$spanDays,$activeDays,$tokTotal,$tokOutput,$tokCacheRead,$updatedAt)
  ON CONFLICT(id) DO UPDATE SET
    tool=$tool,plan=$plan,totalUsd=$totalUsd,monthUsd=$monthUsd,projectedUsd=$projectedUsd,avgDailyUsd=$avgDailyUsd,
    genPct=$genPct,rereadPct=$rereadPct,opusSharePct=$opusSharePct,anomalyRatio=$anomalyRatio,
    spanDays=$spanDays,activeDays=$activeDays,tokTotal=$tokTotal,tokOutput=$tokOutput,tokCacheRead=$tokCacheRead,updatedAt=$updatedAt`);
const delStmt = db.prepare("DELETE FROM subs WHERE id = ?");
const getRow = db.prepare("SELECT * FROM subs WHERE id = ?");

const METRICS = ["projectedUsd", "genPct", "rereadPct", "opusSharePct", "avgDailyUsd"];
const num = (v, lo = 0, hi = 1e12) => { const n = Number(v); return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : 0; };

function cohortValues() {
  const rows = db.query("SELECT " + METRICS.join(",") + " FROM subs").all();
  const cols = {};
  for (const m of METRICS) cols[m] = rows.map((r) => r[m]).filter((v) => v != null && isFinite(v)).sort((a, b) => a - b);
  return { n: rows.length, cols };
}
function pctRank(sorted, x) {
  if (!sorted.length) return null;
  let below = 0; for (const v of sorted) if (v < x) below++; else break;
  return Math.round((below / sorted.length) * 100);
}
function median(sorted) { return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null; }

function compareFor(row) {
  const { n, cols } = cohortValues();
  const pct = {}, med = {};
  for (const m of METRICS) { pct[m] = pctRank(cols[m], row[m]); med[m] = round(median(cols[m]), m.endsWith("Usd") ? 0 : 1); }
  return { cohort: n, pct, median: med };
}
const round = (n, d = 0) => { if (n == null) return null; const f = 10 ** d; return Math.round(n * f) / f; };

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });

function sanitize(b) {
  if (!b || typeof b.id !== "string" || b.id.length < 8 || b.id.length > 64) return null;
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

    if (p === "/submit" && req.method === "POST") {
      let b; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
      const row = sanitize(b);
      if (!row) return json({ error: "invalid payload" }, 400);
      upsert.run({ ...Object.fromEntries(Object.entries(row).map(([k, v]) => ["$" + k, v])) });
      const cmp = compareFor(row);
      return json({ ...cmp, url: `${BASE}/u/${row.id}` });
    }
    if (p === "/forget" && req.method === "POST") {
      let b; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
      if (b?.id) delStmt.run(String(b.id));
      return json({ ok: true });
    }
    if (p === "/stats") return json(statsPayload());
    if (p === "/" || p.startsWith("/u/")) {
      const id = p.startsWith("/u/") ? decodeURIComponent(p.slice(3)) : null;
      return new Response(pageHtml(id), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response("not found", { status: 404 });
  },
});

function statsPayload() {
  const { n, cols } = cohortValues();
  const out = { cohort: n, median: {} };
  for (const m of METRICS) out.median[m] = round(median(cols[m]), m.endsWith("Usd") ? 0 : 1);
  return out;
}

function pageHtml(focusId) {
  const { n, cols } = cohortValues();
  const row = focusId ? getRow.get(focusId) : null;
  const proj = cols.projectedUsd;
  const med = median(proj);
  // simple histogram buckets for projected monthly spend
  const buckets = [0, 100, 300, 600, 1000, 2000, 5000, 1e9];
  const labels = ["<$100", "$100–300", "$300–600", "$600–1k", "$1k–2k", "$2k–5k", "$5k+"];
  const counts = new Array(labels.length).fill(0);
  for (const v of proj) { for (let i = 0; i < labels.length; i++) if (v < buckets[i + 1]) { counts[i]++; break; } }
  const maxc = Math.max(1, ...counts);
  let userBucket = -1;
  if (row) for (let i = 0; i < labels.length; i++) if (row.projectedUsd < buckets[i + 1]) { userBucket = i; break; }
  const bars = labels.map((lb, i) => `
    <div class="brow">
      <div class="blab">${lb}</div>
      <div class="btrack"><div class="bfill${i === userBucket ? " you" : ""}" style="width:${Math.round((counts[i] / maxc) * 100)}%"></div></div>
      <div class="bcount">${counts[i]}${i === userBucket ? ' <span class="youtag">you</span>' : ""}</div>
    </div>`).join("");
  const youLine = row
    ? `<p class="you-summary">You're on pace for <b>$${Math.round(row.projectedUsd).toLocaleString()}/mo</b> — the model was "writing" <b>${row.genPct}%</b> of your tokens, and Opus is <b>${row.opusSharePct}%</b> of your bill.</p>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>vibeaudit — how your AI-coding spend compares</title>
<style>
:root{--bg:#0b0d12;--panel:#12151c;--line:#20242e;--txt:#d6dae2;--dim:#8a92a2;--amber:#f5b34a;--ember:#ff6a2b;--green:#3fd07f;--cyan:#5ad1e0}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at top,#141821,var(--bg) 70%);color:var(--txt);font:16px/1.6 ui-sans-serif,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:56px 20px 80px}.mono{font-family:ui-monospace,Menlo,Consolas,monospace}
.tag{display:inline-block;background:var(--ember);color:#160b06;font-weight:700;padding:3px 10px;border-radius:6px}
h1{font-size:clamp(26px,5vw,38px);margin:18px 0 6px;letter-spacing:-.02em}.sub{color:var(--dim)}
.stat{display:flex;gap:26px;flex-wrap:wrap;margin:26px 0}.stat div b{font-size:26px}.stat div span{color:var(--dim);font-size:13px;display:block}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px 24px;margin-top:24px}
.card h2{margin:0 0 16px;font-size:16px;color:var(--dim);font-weight:600;letter-spacing:.02em;text-transform:uppercase}
.brow{display:flex;align-items:center;gap:12px;margin:7px 0}.blab{width:86px;color:var(--dim);font-size:13px;text-align:right}
.btrack{flex:1;background:#0a0c11;border-radius:6px;height:20px;overflow:hidden}.bfill{height:100%;background:#2b3342;border-radius:6px}
.bfill.you{background:var(--ember)}.bcount{width:60px;font-size:13px;color:var(--dim)}.youtag{color:var(--ember);font-weight:700}
.you-summary{background:#161a22;border:1px solid var(--line);border-left:3px solid var(--ember);border-radius:8px;padding:12px 16px;margin-top:20px}
.trust{margin-top:34px;color:var(--dim);font-size:13px;border-top:1px solid var(--line);padding-top:18px}
code{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px 12px;color:#fff}.cyan{color:var(--cyan)}
</style></head><body><div class="wrap">
<span class="tag">vibeaudit</span>
<h1>How your AI-coding spend compares</h1>
<p class="sub">Anonymous, self-reported numbers from developers running <span class="mono">vibeaudit --compare</span>.</p>
${youLine}
<div class="stat">
  <div><b>${n.toLocaleString()}</b><span>developers</span></div>
  <div><b>$${med ? Math.round(med).toLocaleString() : "—"}</b><span>median projected / month</span></div>
</div>
<div class="card"><h2>Projected monthly spend — distribution</h2>${bars}</div>
<p style="margin-top:26px">See your own numbers: <code class="mono"><span class="cyan">npx</span> vibeaudit --compare</code></p>
<div class="trust">
🔒 <b>What we store:</b> only anonymous aggregate numbers (spend totals, percentages, model mix). <b>Never</b> your code,
prompts, file names, or project names. No accounts, no email, <b>no IP addresses</b>. Each row is a random id you can
delete anytime with <span class="mono">vibeaudit --forget</span>. The client is open source — verify exactly what's sent.
</div>
</div></body></html>`;
}

console.log(`vibeaudit compare server on :${PORT} (db ${DB_PATH})`);
