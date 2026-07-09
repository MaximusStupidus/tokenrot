// Seed a synthetic cohort through the REAL /submit path (so handles/validation are exercised),
// then flag every row synthetic=1 and spread updatedAt over the past 3 days.
// Run on the box:  bun server/seed.js [count]        (default 36)
// Purge later:     bun server/seed.js --purge        (removes ONLY synthetic rows)
import { Database } from "bun:sqlite";

const API = process.env.SEED_API || "http://127.0.0.1:7200";
const DB_PATH = process.env.VIBEAUDIT_DB || "/home/ubuntu/prod/vibeaudit/vibeaudit.db";

if (process.argv.includes("--purge")) {
  const db = new Database(DB_PATH);
  const { changes } = db.run("DELETE FROM subs WHERE synthetic = 1");
  console.log(`purged ${changes} synthetic rows`);
  process.exit(0);
}

const N = Number(process.argv[2]) || 36;
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const round = (n, d = 0) => Math.round(n * 10 ** d) / 10 ** d;

// Spend distribution from the research: most devs $80–400/mo, a mid band, a heavy tail.
function sampleProj() {
  const r = Math.random();
  if (r < 0.42) return rnd(60, 320);        // hobby / plan-limit devs
  if (r < 0.75) return rnd(320, 900);       // steady daily users
  if (r < 0.93) return rnd(900, 2400);      // heavy users
  return rnd(2400, 6800);                    // tokenmaxxers
}

const seeded = [];
for (let i = 0; i < N; i++) {
  const proj = sampleProj();
  const spanDays = Math.round(rnd(21, 75));
  const activeDays = Math.max(5, Math.round(spanDays * rnd(0.45, 0.95)));
  const opus = round(rnd(0.3, 1) < 0.55 ? rnd(55, 98) : rnd(20, 55), 1);
  const reread = round(rnd(82, 97), 1);
  const gen = round(rnd(0.25, 3.4), 2);
  const tools = [...new Set([pick(["claude-code", "claude-code", "claude-code", "cursor"]), ...(Math.random() < 0.45 ? [pick(["cursor", "codex", "copilot", "aider", "windsurf"])] : [])])];
  const body = {
    id: "seed-" + crypto.randomUUID(),
    tool: "Claude Code",
    plan: pick([100, 200, 200, 200, null]),
    role: pick(["engineer", "engineer", "engineer", "founder", "founder", "student", "researcher", "other"]),
    tools,
    pays: pick(["self", "self", "employer", "both"]),
    aiShare: pick(["under 25%", "25-75%", "25-75%", "over 75%", "100% - i am merely the reviewer now"]),
    feels: pick(["worth every cent", "worth every cent", "mild guilt", "physical pain", "nothing - employer pays"]),
    projectedUsd: round(proj),
    monthUsd: round(proj * rnd(0.3, 0.9)),
    totalUsd: round(proj * (spanDays / 30)),
    avgDailyUsd: round(proj / 30, 2),
    genPct: gen,
    rereadPct: reread,
    opusSharePct: opus,
    anomalyRatio: round(Math.random() < 0.2 ? rnd(1.5, 2.6) : rnd(0.6, 1.4), 2),
    spanDays,
    activeDays,
    tokens: { total: Math.round(proj * rnd(180000, 260000)), output: Math.round(proj * rnd(1200, 4000)), cacheRead: Math.round(proj * rnd(160000, 230000)) },
  };
  const res = await fetch(API + "/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json();
  if (j.handle) seeded.push(j.handle);
  else console.error("seed failed:", JSON.stringify(j));
}

// flag as synthetic + spread updatedAt over the last 72h so the board reads alive
const db = new Database(DB_PATH);
db.run("UPDATE subs SET synthetic = 1 WHERE id LIKE 'seed-%'");
const rows = db.query("SELECT id FROM subs WHERE synthetic = 1").all();
const upd = db.prepare("UPDATE subs SET updatedAt = ? WHERE id = ?");
for (const r of rows) upd.run(Date.now() - Math.round(rnd(0.2, 72) * 3600 * 1000), r.id);

console.log(`seeded ${seeded.length} synthetic devs (flagged synthetic=1, updatedAt spread over 72h)`);
console.log("sample handles:", seeded.slice(0, 5).join(", "));
