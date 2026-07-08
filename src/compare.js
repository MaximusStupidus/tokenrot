import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { c, box, bar, padEnd, padStart } from "./ansi.js";
import { usd } from "./render.js";

export const API_BASE = process.env.TOKENROT_API || "https://tokenrot.comsync.in";

// ── anonymous local id ──────────────────────────────────────────────
function idPath() {
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "tokenrot");
  return { dir, file: path.join(dir, "id") };
}
export function getAnonId() {
  const { dir, file } = idPath();
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    const id = crypto.randomUUID();
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, id + "\n", { mode: 0o600 }); } catch {}
    return id;
  }
}
function clearAnonId() {
  try { fs.rmSync(idPath().file); } catch {}
}

// ── the ONLY thing that ever leaves the machine ─────────────────────
export function buildPayload(x, { tool, plan }) {
  const modelMix = {};
  for (const m of x.models) modelMix[m.model] = round((m.cost / (x.totals.cost || 1)) * 100, 1);
  const opus = x.models.find((m) => m.model === "Opus");
  return {
    id: getAnonId(),
    v: 1,
    tool: tool || "Claude Code",
    plan: plan || null,
    spanDays: x.spanDays || null,
    activeDays: x.activeDays,
    totalUsd: round(x.totals.cost),
    monthUsd: round(x.thisMonthCost),
    projectedUsd: round(x.projectedMonthCost),
    avgDailyUsd: round(x.avgDaily),
    genPct: round(x.generationPct, 2),
    rereadPct: round(x.rereadPct, 1),
    opusSharePct: opus ? round((opus.cost / (x.totals.cost || 1)) * 100, 1) : 0,
    anomalyRatio: round(x.anomalyRatio, 2),
    tokens: {
      input: x.totals.input,
      output: x.totals.output,
      cacheRead: x.totals.cacheRead,
      cacheWrite: x.totals.cacheWrite,
      total: x.totals.totalTokens,
    },
    modelMix,
  };
}
const round = (n, d = 0) => { const f = 10 ** d; return Math.round((n || 0) * f) / f; };

// ── consent screen (radical transparency) ───────────────────────────
export function showConsent(payload) {
  const pretty = JSON.stringify(payload, null, 2).split("\n");
  const out = [];
  out.push("");
  out.push(`  ${c.bold("Compare anonymously with other AI-coding spenders.")}`);
  out.push("");
  out.push(`  ${c.gray("This is")} ${c.bold("the only thing")} ${c.gray("that would be uploaded — anonymous numbers, no code:")}`);
  out.push("");
  out.push(box(pretty.map((l) => c.cyan(l)), { title: c.gray("payload"), color: c.gray }).split("\n").map((l) => "  " + l).join("\n"));
  out.push("");
  out.push(`  ${c.green("✓")} ${c.dim("You'll appear on the public board under a random handle (like ")}${c.cyan("feral-cachegoblin-73")}${c.dim(") — never your name.")}`);
  out.push(`  ${c.green("✓")} ${c.dim("No account, no email. Never sent: your code, prompts, file names, or project names.")}`);
  out.push(`  ${c.green("✓")} ${c.dim("The server stores no IP address. Delete anytime with ")}${c.cyan("tokenrot --forget")}${c.dim(".")}`);
  out.push("");
  return out.join("\n");
}

export function ask(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const onData = (d) => { cleanup(); resolve(String(d).trim().toLowerCase()); };
    const cleanup = () => { process.stdin.pause(); process.stdin.removeListener("data", onData); };
    try { process.stdin.resume(); process.stdin.once("data", onData); }
    catch { resolve("n"); }
  });
}

// ── network ─────────────────────────────────────────────────────────
async function post(pathname, body) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 12000);
  try {
    const r = await fetch(API_BASE + pathname, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!r.ok) return { error: `server returned ${r.status}` };
    return await r.json();
  } catch (e) {
    return { error: e.name === "AbortError" ? "timed out" : "couldn't reach the compare server" };
  } finally {
    clearTimeout(t);
  }
}

export async function upload(payload) {
  return post("/submit", payload);
}

export async function forget() {
  const id = getAnonId();
  const res = await post("/forget", { id });
  clearAnonId();
  return res;
}

// ── the ranking view ────────────────────────────────────────────────
export function renderComparison(res, payload) {
  if (res.error) {
    return `\n  ${c.yellow("Couldn't compare right now")} ${c.dim("(" + res.error + ").")} ${c.dim("Your local report above is unaffected — nothing was uploaded successfully.")}\n`;
  }
  const L = [];
  const p = (s = "") => L.push(s);
  const n = res.cohort || 0;
  p();
  if (res.handle) p(`  ${c.green("✓ You're on the board as")} ${c.bold(c.ember("@" + res.handle))} ${c.gray(`— ranked against ${n.toLocaleString()} ${n === 1 ? "dev" : "devs"}.`)}`);
  else p(`  ${c.green("✓ Uploaded.")} ${c.gray("You're compared against")} ${c.white(n.toLocaleString())} ${c.gray(n === 1 ? "dev." : "devs.")}`);
  p();
  const rows = [
    ["Monthly (projected)", usd(payload.projectedUsd), res.pct?.projectedUsd, res.median?.projectedUsd ? usd(res.median.projectedUsd) : null],
    ["Model writing code", payload.genPct + "%", res.pct?.genPct, res.median?.genPct != null ? res.median.genPct + "%" : null],
    ["Spent re-reading", payload.rereadPct + "%", res.pct?.rereadPct, res.median?.rereadPct != null ? res.median.rereadPct + "%" : null],
    ["Opus share", payload.opusSharePct + "%", res.pct?.opusSharePct, res.median?.opusSharePct != null ? res.median.opusSharePct + "%" : null],
    ["Burn / day", usd(payload.avgDailyUsd), res.pct?.avgDailyUsd, res.median?.avgDailyUsd ? usd(res.median.avgDailyUsd) : null],
  ];
  for (const [label, val, pctRank, median, higherIsMore] of rows) {
    if (pctRank == null) continue;
    const top = Math.round(100 - pctRank);
    const rankTxt = top <= 50 ? c.ember(`top ${Math.max(1, top)}%`) : c.gray(`bottom ${Math.max(1, Math.round(pctRank))}%`);
    const barCol = top <= 25 ? c.ember : top <= 50 ? c.amber : c.gray;
    p(`  ${c.gray(padEnd(label, 20))} ${padStart(val, 8)}  ${bar(pctRank, 18, barCol)}  ${padEnd(rankTxt, 10)} ${median ? c.dim("median " + median) : ""}`);
  }
  // ── how to cut the burn — personalized, rule-generated from YOUR numbers ──
  const tips = buildTips(payload, res);
  if (tips.length) {
    p();
    p(`  ${c.bold("HOW TO CUT THE BURN")}   ${c.dim("(from your numbers, not generic advice)")}`);
    p();
    for (const t of tips.slice(0, 3)) {
      p(`  ${c.ember("›")} ${t.head}`);
      p(`    ${c.dim(t.how)}`);
    }
  }
  p();
  if (res.url) p(`  ${c.gray("share your card:")}  ${c.cyan(res.url)}`);
  p(`  ${c.dim("the board:")} ${c.cyan(res.board || API_BASE)}   ${c.dim("·  delete your data:")} ${c.cyan("tokenrot --forget")}`);
  p();
  return L.join("\n");
}

// Deterministic improvement tips — computed locally from the payload + cohort medians.
// No LLM, no extra network. Ordered by estimated $ impact.
export function buildTips(pl, res) {
  const tips = [];
  const proj = pl.projectedUsd || 0;
  const med = res.median || {};

  // 1. Model routing — usually the biggest lever
  if (pl.opusSharePct >= 60 && proj > 50) {
    const save = proj * (pl.opusSharePct / 100) * 0.3 * 0.8; // shift 30% of Opus work to ~5x cheaper
    tips.push({
      impact: save,
      head: `Opus is ${pl.opusSharePct}% of your bill — routing routine work to Sonnet could save ~${usd(save)}/mo.`,
      how: `Keep Opus for architecture & hard debugging; use /model sonnet (or claude --model sonnet) for edits, tests, boilerplate.`,
    });
  }
  // 2. Context re-read burn
  if (pl.rereadPct >= 85) {
    const save = proj * 0.12;
    tips.push({
      impact: save,
      head: `${Math.round(pl.rereadPct)}% of your tokens re-read the same context — shorter sessions could save ~${usd(save)}/mo.`,
      how: `Run /compact at natural breakpoints, /clear between tasks, and trim CLAUDE.md — every turn re-reads it.`,
    });
  }
  // 3. Burn spike
  if (pl.anomalyRatio >= 1.5) {
    tips.push({
      impact: proj * 0.1,
      head: `Your last 3 days ran ${pl.anomalyRatio}× your own normal — check for a runaway loop or a hook re-triggering.`,
      how: `Look at your busiest recent session; agents retrying in a loop quietly eat 10-100× a normal session.`,
    });
  }
  // 4. Low generation share vs cohort
  if (med.genPct != null && pl.genPct < med.genPct * 0.6) {
    tips.push({
      impact: proj * 0.08,
      head: `Only ${pl.genPct}% of your tokens are new code (cohort median ${med.genPct}%) — big contexts, small outputs.`,
      how: `Scope tasks tighter and point Claude at specific files instead of letting it re-explore the repo each time.`,
    });
  }
  // 5. Positive reinforcement when they're lean
  if (!tips.length && res.pct?.projectedUsd != null && res.pct.projectedUsd <= 40) {
    tips.push({
      impact: 0,
      head: `You're leaner than ${100 - res.pct.projectedUsd}% of the board — your routing/context habits are already working.`,
      how: `Re-run tokenrot --compare after heavy weeks to catch regressions early.`,
    });
  }
  return tips.sort((a, b) => b.impact - a.impact);
}
