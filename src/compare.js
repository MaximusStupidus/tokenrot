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

// ── THE VIBE CHECK — 5 quick MCQs before the board ──────────────────
// Mandatory-but-humane: blank answers get one nudge, then we let it go (and
// piped/--yes runs skip the whole thing). Every question ends in "add your own".
// Asked BEFORE the consent preview so answers appear in the exact payload shown.
const clean = (s) => String(s).toLowerCase().replace(/[^a-z0-9 %_\/-]/g, "").replace(/\s+/g, " ").trim().slice(0, 40) || null;

async function askMCQ(label, options, { multi = false } = {}) {
  const ownIdx = options.length + 1;
  const menu = options.map((o, i) => `${c.dim(String(i + 1))} ${o}`).join("  ") + `  ${c.dim(String(ownIdx))} ${c.dim("add your own")}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await ask(`  ${c.gray(label)}${multi ? c.dim(" (comma-sep)") : ""}\n    ${menu} ${c.dim("›")} `);
    if (!raw) {
      if (attempt === 0) { console.log(`  ${c.dim("c'mon, it's one keypress — the flywheel is hungry.")}`); continue; }
      return null; // second blank: we're not monsters
    }
    const picks = (multi ? raw.split(/[\s,]+/) : [raw]).filter(Boolean);
    const out = [];
    let wantsOwn = false;
    for (const p of picks) {
      const n = Number(p);
      if (n === ownIdx) wantsOwn = true;
      else if (n >= 1 && n <= options.length) out.push(options[n - 1].replace(/ \(.*\)$/, ""));
      else if (isNaN(n) && clean(p)) out.push(clean(p)); // they just typed the answer — respect it
    }
    if (wantsOwn) {
      const own = clean(await ask(`    ${c.gray("go on, type it")} ${c.dim("›")} `));
      if (own) out.push(own);
    }
    if (out.length) return multi ? [...new Set(out)] : out[0];
  }
  return null;
}

// Arrow-key selector for real terminals: ↑↓ to move, Space toggles (multi),
// Enter confirms. Typing is only for "add your own". Collapses to one ✓ line.
function selectMCQ(label, options, { multi = false } = {}) {
  const opts = [...options, "add your own"];
  const OWN = opts.length - 1;
  return new Promise((resolve) => {
    const out = process.stdout, stdin = process.stdin;
    let idx = 0;
    const picked = new Set();
    const hint = multi ? "↑↓ move · space toggles · enter confirms" : "↑↓ move · enter selects";
    const render = (first = false) => {
      if (!first) out.write(`\x1b[${opts.length}A`);
      for (let i = 0; i < opts.length; i++) {
        out.write("\x1b[2K");
        const cur = i === idx;
        const mark = multi
          ? (picked.has(i) ? c.ember("◉") : c.dim("○"))
          : (cur ? c.ember("❯") : " ");
        const label_ = i === OWN ? (cur ? c.bold("add your own…") : c.dim("add your own…")) : (cur ? c.bold(c.white(opts[i])) : opts[i]);
        out.write(`    ${cur && multi ? c.ember("›") : " "}${mark} ${label_}\n`);
      }
    };
    out.write(`\n  ${c.gray(label)}  ${c.dim("(" + hint + ")")}\n`);
    out.write("\x1b[?25l");
    render(true);
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding("utf8");
    const collapse = () => {
      out.write(`\x1b[${opts.length + 2}A\x1b[J`); // wipe the menu block
    };
    const finish = async (choices, rest = "") => {
      stdin.setRawMode(false); stdin.pause(); stdin.removeListener("data", onKey);
      if (rest) stdin.unshift(rest); // hand unconsumed keys to the next prompt
      out.write("\x1b[?25h");
      collapse();
      let vals = choices.filter((i) => i !== OWN).map((i) => opts[i].replace(/ \(.*\)$/, ""));
      if (choices.includes(OWN)) {
        const own = clean(await ask(`  ${c.gray(label)} ${c.dim("— type yours")} ${c.dim("›")} `));
        out.write("\x1b[1A\x1b[2K"); // tidy the typed line too
        if (own) vals.push(own);
      }
      const val = multi ? (vals.length ? [...new Set(vals)] : null) : (vals[0] ?? null);
      out.write(`  ${c.green("✓")} ${c.gray(label)} ${c.dim("›")} ${c.white(multi && val ? val.join(", ") : val ?? c.dim("(skipped)"))}\n`);
      resolve(val);
    };
    const onKey = (chunk) => {
      // a chunk may carry several keys (paste, fast input) — split into tokens
      const keys = String(chunk).match(/\x1b\[[A-D]|[\s\S]/g) || [];
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (k === "\x03") { stdin.setRawMode(false); out.write("\x1b[?25h\n"); process.exit(130); }
        else if (k === "\x1b[A" || k === "\x1b[D" || k === "k") { idx = (idx - 1 + opts.length) % opts.length; render(); }
        else if (k === "\x1b[B" || k === "\x1b[C" || k === "j" || k === "\t") { idx = (idx + 1) % opts.length; render(); }
        else if (k === " " && multi) { picked.has(idx) ? picked.delete(idx) : picked.add(idx); render(); }
        else if (k === "\r" || k === "\n") {
          const choices = multi ? (picked.size ? [...picked] : [idx]) : [idx];
          finish(choices, keys.slice(i + 1).join("")); // unconsumed keys → next prompt
          return;
        }
      }
    };
    stdin.on("data", onKey);
  });
}

export async function runSurvey() {
  console.log(`
  ${c.bold(c.ember("THE VIBE CHECK"))} ${c.dim("— 5 quick ones before you hit the board (~20 seconds).")}
  ${c.dim("Why: labeled data makes the flywheel spin — better cohorts → sharper benchmarks →")}
  ${c.dim("better receipts for everyone, including you. Anonymous, obviously.")}`);
  // real terminal → arrow-key selector; pipes/CI → numbered fallback
  const interactive = !!(process.stdin.isTTY && process.stdout.isTTY && typeof process.stdin.setRawMode === "function");
  const pickOne = (label, options) => (interactive ? selectMCQ(label, options) : askMCQ(label, options));
  const pickMany = (label, options) => (interactive ? selectMCQ(label, options, { multi: true }) : askMCQ(label, options, { multi: true }));

  const role = await pickOne("What are you?", ["engineer", "founder/indie hacker", "student", "researcher"]);
  const tools = await pickMany("Which AI coding tools have touched your codebase?", ["claude-code", "cursor", "codex", "copilot", "windsurf", "aider"]);
  const pays = await pickOne("Who pays the bill?", ["me, painfully (self)", "employer (bless them)", "both"]);
  const aiShare = await pickOne("How much of your shipped code does the AI write these days?", ["under 25%", "25-75%", "over 75%", "100% - i am merely the reviewer now"]);
  const feels = await pickOne("When you see what you've burned, you feel:", ["worth every cent", "mild guilt", "physical pain", "nothing - employer pays"]);
  console.log(`  ${c.green("✓")} ${c.dim("vibe recorded. the flywheel thanks you.")}`);
  // normalize the pays presets back to canonical values
  const PAYS_MAP = { "me, painfully": "self", "employer": "employer", both: "both" };
  return { role, tools: tools || null, pays: PAYS_MAP[pays] || pays, aiShare, feels };
}

// ── the ONLY thing that ever leaves the machine ─────────────────────
export function buildPayload(x, { tool, plan, survey }) {
  const modelMix = {};
  for (const m of x.models) modelMix[m.model] = round((m.cost / (x.totals.cost || 1)) * 100, 1);
  const opus = x.models.find((m) => m.model === "Opus");
  return {
    id: getAnonId(),
    v: 1,
    tool: tool || "Claude Code",
    plan: plan || null,
    role: survey?.role || null,
    tools: survey?.tools || null,
    pays: survey?.pays || null,
    aiShare: survey?.aiShare || null,
    feels: survey?.feels || null,
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

// Line-buffered prompt. Piped stdin can deliver several answers in one chunk —
// we split on newlines and queue the extras so later prompts don't hang.
const _lineQueue = [];
let _stdinEnded = false;
export function ask(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    if (_lineQueue.length) return resolve(_lineQueue.shift());
    if (_stdinEnded) return resolve("");
    const onData = (d) => {
      const lines = String(d).split("\n");
      const first = lines.shift().trim().toLowerCase();
      for (const l of lines) if (l.trim()) _lineQueue.push(l.trim().toLowerCase());
      cleanup(); resolve(first);
    };
    const onEnd = () => { _stdinEnded = true; cleanup(); resolve(""); };
    const cleanup = () => { process.stdin.pause(); process.stdin.removeListener("data", onData); process.stdin.removeListener("end", onEnd); };
    try { process.stdin.resume(); process.stdin.once("data", onData); process.stdin.once("end", onEnd); }
    catch { resolve(""); }
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
