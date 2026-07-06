import path from "node:path";

// Aggregate raw usage records into the numbers we show. Pure function, easy to test.
export function computeInsights(records) {
  const t = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, webSearch: 0 };
  const byModel = new Map();
  const byDay = new Map();
  const bySession = new Map();
  const byProject = new Map();
  let firstTs = Infinity, lastTs = -Infinity;

  for (const r of records) {
    t.cost += r.cost;
    t.input += r.input;
    t.output += r.output;
    t.cacheRead += r.cacheRead;
    t.cacheWrite += r.cacheWrite5m + r.cacheWrite1h;
    t.totalTokens += r.totalTokens;
    t.webSearch += r.webSearch;

    add(byModel, shortModel(r.model), r);
    add(bySession, r.session, r);
    add(byProject, projectLabel(r.cwd), r);
    if (r.ts) {
      firstTs = Math.min(firstTs, r.ts);
      lastTs = Math.max(lastTs, r.ts);
      add(byDay, dayKey(r.ts), r);
    }
  }

  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  let thisMonthCost = 0;
  for (const [day, v] of byDay) if (day.startsWith(monthKey)) thisMonthCost += v.cost;
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const projectedMonthCost = dayOfMonth > 0 ? (thisMonthCost / dayOfMonth) * daysInMonth : thisMonthCost;

  // last 30d + anomaly (last 3 days vs the 27 before)
  const DAY = 86400000;
  let last30 = 0, last3 = 0, prior = 0, prior3days = new Set();
  for (const [day, v] of byDay) {
    const age = (now - new Date(day + "T12:00:00")) / DAY;
    if (age <= 30) last30 += v.cost;
    if (age <= 3) { last3 += v.cost; }
    else if (age <= 30) prior += v.cost;
  }
  const last3Daily = last3 / 3;
  const priorDaily = prior / 27;
  const anomalyRatio = priorDaily > 0 ? last3Daily / priorDaily : 0;

  const days = [...byDay.entries()].map(([d, v]) => ({ day: d, ...v }));
  const busiestDay = days.sort((a, b) => b.cost - a.cost)[0] || null;
  const activeDays = byDay.size;
  const avgDaily = activeDays ? t.cost / activeDays : 0;

  const topSessions = [...bySession.entries()].map(([s, v]) => ({ session: s, ...v })).sort((a, b) => b.cost - a.cost);
  const topProjects = [...byProject.entries()].map(([p, v]) => ({ project: p, ...v })).sort((a, b) => b.cost - a.cost);
  const models = [...byModel.entries()].map(([m, v]) => ({ model: m, ...v })).sort((a, b) => b.cost - a.cost);

  const generationPct = t.totalTokens ? (t.output / t.totalTokens) * 100 : 0;
  const rereadPct = t.totalTokens ? (t.cacheRead / t.totalTokens) * 100 : 0;
  const words = Math.round(t.totalTokens * 0.75);

  return {
    totals: t,
    records: records.length,
    sessions: bySession.size,
    projects: byProject.size,
    models,
    days,
    firstTs: isFinite(firstTs) ? firstTs : null,
    lastTs: isFinite(lastTs) ? lastTs : null,
    spanDays: isFinite(firstTs) ? Math.max(1, Math.round((lastTs - firstTs) / DAY)) : null,
    activeDays,
    avgDaily,
    thisMonthCost,
    projectedMonthCost,
    last30,
    anomalyRatio,
    last3Daily,
    priorDaily,
    busiestDay,
    topSessions,
    topProjects,
    generationPct,
    rereadPct,
    words,
  };
}

function add(map, key, r) {
  const v = map.get(key) || { cost: 0, tokens: 0, ts: 0 };
  v.cost += r.cost;
  v.tokens += r.totalTokens;
  if (r.ts && r.ts > v.ts) v.ts = r.ts;
  map.set(key, v);
}
function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function shortModel(m) {
  const s = m.toLowerCase();
  if (s.includes("opus")) return "Opus";
  if (s.includes("sonnet")) return "Sonnet";
  if (s.includes("haiku")) return "Haiku";
  if (s.includes("fable")) return "Fable";
  if (s.includes("gpt") || s.includes("codex")) return "Codex/GPT";
  return m.replace(/^claude-/, "");
}
function projectLabel(cwd) {
  if (!cwd) return "unknown";
  const base = path.basename(cwd);
  return base || cwd;
}
