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
  ${c.bgOrange(" burnrate ")}  the truth about your AI-coding spend

  Usage:  npx burnrate [options]

  Reads your local Claude Code / Codex logs and shows where your
  tokens and money actually go. 100% on-device — nothing is uploaded.

  Options:
    --since <days>   only the last N days
    --json           print raw numbers as JSON (no UI)
    --no-color       plain text (or set NO_COLOR=1)
    -h, --help       this help

  Privacy: your code and prompts never leave your machine. Only reads
  token/usage metadata from files already on disk.
`);
  process.exit(0);
}

const sources = discoverSources();
if (sources.length === 0) {
  console.log(`
  ${c.bgOrange(" burnrate ")}

  ${c.yellow("No Claude Code or Codex logs found on this machine.")}

  We look in:
    ~/.claude/projects/**/*.jsonl   ${c.dim("(Claude Code)")}
    ~/.codex/sessions/**/*.jsonl    ${c.dim("(Codex)")}

  Use one of those tools, then run ${c.cyan("npx burnrate")} again.
`);
  process.exit(0);
}

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
console.log(render(insights, { fileCount, tools: sources.map((s) => s.tool), plan }));
