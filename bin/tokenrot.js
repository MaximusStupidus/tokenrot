#!/usr/bin/env node
import { discoverSources } from "../src/discover.js";
import { parseFile } from "../src/parse.js";
import { computeInsights } from "../src/insights.js";
import { render } from "../src/render.js";
import { c } from "../src/ansi.js";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

if (has("-h") || has("--help")) {
  console.log(`
  ${c.bgOrange(" tokenrot ")}  the truth about your AI-coding spend

  Usage:  npx tokenrot [options]        (or: npm i -g tokenrot → tokenrot)

  Reads your local Claude Code / Codex logs and shows where your
  tokens and money actually go. 100% on-device — nothing is uploaded.

  Options:
    --since <days>   only the last N days
    --plan <usd>     your monthly plan, for value math (default 200)
    --compare        see how you rank vs other devs (anonymous, opt-in)
    --forget         delete your anonymous comparison data
    --no-fetch       skip the live price fetch, use bundled prices (offline)
    --json           print raw numbers as JSON (no UI)
    --no-color       plain text (or set NO_COLOR=1)
    -h, --help       this help

  Privacy: your code and prompts never leave your machine. Only reads
  token/usage metadata from files already on disk.
`);
  process.exit(0);
}

// --demo: synthetic data, for screenshots. Never reads your logs.
if (has("--demo")) {
  const { demoRecords } = await import("../src/demo.js");
  const insights = computeInsights(demoRecords());
  console.log(render(insights, { fileCount: 0, tools: ["demo"], plan: 200, demo: true }));
  process.exit(0);
}

// --forget: delete anonymous comparison data (needs no logs)
if (has("--forget")) {
  const { forget } = await import("../src/compare.js");
  const res = await forget();
  if (res.error) console.log(`\n  ${c.yellow("Couldn't reach the server")} ${c.dim("(" + res.error + ") — your local id was cleared anyway.")}\n`);
  else console.log(`\n  ${c.green("✓ Done.")} ${c.dim("Your anonymous data was deleted and your local id removed.")}\n`);
  process.exit(0);
}

const sources = discoverSources();
if (sources.length === 0) {
  console.log(`
  ${c.bgOrange(" tokenrot ")}

  ${c.yellow("No Claude Code or Codex logs found on this machine.")}

  We look in:
    ~/.claude/projects/**/*.jsonl   ${c.dim("(Claude Code)")}
    ~/.codex/sessions/**/*.jsonl    ${c.dim("(Codex)")}

  Use one of those tools, then run ${c.cyan("npx tokenrot")} again.
`);
  process.exit(0);
}

// live prices before any cost math — best-effort GET, cached locally, offline-safe.
// sends nothing about you; falls back to cache then bundled prices.
const { loadPrices } = await import("../src/prices.js");
const priceInfo = await loadPrices({ offline: has("--no-fetch") || has("--offline") || !!process.env.TOKENROT_OFFLINE });

// parse all files (with a light progress line to stderr)
const sinceDays = Number(val("--since", 0));
const cutoff = sinceDays > 0 ? Date.now() - sinceDays * 86400000 : 0;
let records = [];
let fileCount = 0;
const totalFiles = sources.reduce((n, s) => n + s.files.length, 0);
const tty = process.stderr.isTTY;
for (const s of sources) {
  for (const f of s.files) {
    fileCount++;
    if (tty && fileCount % 50 === 0) process.stderr.write(`\r  ${c.dim(`analyzing… ${fileCount}/${totalFiles}`)}`);
    let recs = parseFile(f, s.tool);
    if (cutoff) recs = recs.filter((r) => !r.ts || r.ts >= cutoff);
    records.push(...recs);
  }
}
if (tty) process.stderr.write("\r" + " ".repeat(40) + "\r");

if (records.length === 0) {
  console.log(`\n  ${c.yellow("Found log files, but no usage data in the selected range.")}\n`);
  process.exit(0);
}

const insights = computeInsights(records);

if (has("--json")) {
  const { days, topSessions, topProjects, ...slim } = insights;
  console.log(JSON.stringify({ ...slim, topProjects: topProjects.slice(0, 10) }, null, 2));
  process.exit(0);
}

const plan = Number(val("--plan", 200)) || 200;
console.log(render(insights, { fileCount, tools: sources.map((s) => s.tool), plan, prices: priceInfo }));

// --compare: opt-in, anonymous ranking vs other devs
if (has("--compare")) {
  const cmp = await import("../src/compare.js");
  const survey = has("--yes") || has("-y") ? null : await cmp.runSurvey();
  const payload = cmp.buildPayload(insights, { tool: sources[0]?.tool, plan: Number(val("--plan", "")) || null, survey });
  process.stdout.write(cmp.showConsent(payload));
  const yes = has("--yes") || has("-y");
  const ans = yes ? "y" : await cmp.ask(`  ${c.bold("Upload these numbers and see where you rank?")} ${c.dim("[y/N]")} `);
  if (ans === "y" || ans === "yes") {
    const res = await cmp.upload(payload);
    console.log("\n" + cmp.renderComparison(res, payload));
  } else {
    console.log(`\n  ${c.gray("No problem — nothing was uploaded.")}\n`);
  }
  process.exit(0);
}
