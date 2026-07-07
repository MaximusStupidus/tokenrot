import { c, bar, box, hr, padEnd, padStart, width } from "./ansi.js";

export const usd = (n) =>
  n >= 1000 ? "$" + Math.round(n).toLocaleString("en-US") : n >= 1 ? "$" + n.toFixed(2) : "$" + n.toFixed(2);
export const toks = (n) => {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
};
const pct = (n) => n.toFixed(n < 10 ? 1 : 0) + "%";
const int = (n) => Math.round(n).toLocaleString("en-US");
const dateShort = (ts) => (ts ? new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—");

export function render(x, meta) {
  const L = [];
  const p = (s = "") => L.push(s);

  // ── banner ──────────────────────────────────────────────
  p();
  p(`  ${c.bgOrange(" vibeaudit ")}  ${c.gray("the truth about your AI-coding spend")}`);
  p();

  // ── headline shock ──────────────────────────────────────
  const gen = x.generationPct;
  p(`  ${c.gray("Across")} ${c.white(x.records.toLocaleString())} ${c.gray("messages in")} ${c.white(x.sessions.toLocaleString())} ${c.gray("sessions,")} ${c.gray("Claude was actually")}`);
  p(`  ${c.gray("writing code")} ${c.bold(c.ember(gen.toFixed(gen < 1 ? 2 : 1) + "%"))} ${c.gray("of the time.")}  ${c.dim("The other " + (100 - gen).toFixed(gen < 1 ? 2 : 1) + "% was reading context.")}`);
  p();
  const total = x.totals.cost;
  p(`  ${c.gray("You've burned")}  ${c.bold(c.amber(usd(total)))} ${c.gray("in API-equivalent value")}${x.spanDays ? c.gray(` over ${x.spanDays} days`) : ""}.`);
  p();
  p("  " + hr(60));

  // ── where your tokens went ──────────────────────────────
  p();
  p(`  ${c.bold("WHERE YOUR TOKENS WENT")}   ${c.dim("(by volume)")}`);
  p();
  const tt = x.totals.totalTokens || 1;
  const rows = [
    ["Re-reading old context", x.totals.cacheRead, c.gray, "cache read"],
    ["Loading new context", x.totals.cacheWrite, c.amber, "cache write"],
    ["Your prompts", x.totals.input, c.cyan, "input"],
    ["Claude writing code", x.totals.output, c.green, "output ← the actual work"],
  ];
  for (const [label, val, col, note] of rows) {
    const pc = (val / tt) * 100;
    p(`  ${padEnd(label, 22)} ${bar(pc, 22, col)} ${padStart(pct(pc), 5)}  ${c.dim(toks(val))}  ${c.dim(note)}`);
  }
  p();

  // ── where your money went (by model) ────────────────────
  p("  " + hr(60));
  p();
  p(`  ${c.bold("WHERE YOUR MONEY WENT")}   ${c.dim("(by model)")}`);
  p();
  const shownModels = x.models.filter((m) => m.cost >= total * 0.001 || m.cost >= 0.5);
  const maxCost = Math.max(...shownModels.map((m) => m.cost), 1e-9);
  for (const m of shownModels.slice(0, 6)) {
    const pc = (m.cost / total) * 100;
    const col = m.model === "Opus" ? c.pink : m.model === "Sonnet" ? c.cyan : m.model === "Fable" ? c.magenta : c.blue;
    p(`  ${padEnd(m.model, 12)} ${bar((m.cost / maxCost) * 100, 22, col)} ${padStart(usd(m.cost), 9)}  ${c.dim(padStart(pct(pc), 4))}  ${c.dim(toks(m.tokens))}`);
  }
  p();

  // ── the numbers ─────────────────────────────────────────
  p("  " + hr(60));
  p();
  p(`  ${c.bold("THE NUMBERS")}`);
  p();
  const grid = [
    ["This month", c.amber(usd(x.thisMonthCost)), "Projected month", c.amber(usd(x.projectedMonthCost))],
    ["Avg / active day", usd(x.avgDaily), "Active days", String(x.activeDays)],
    ["Busiest day", x.busiestDay ? `${usd(x.busiestDay.cost)} ${c.dim("(" + x.busiestDay.day.slice(5) + ")")}` : "—", "Priciest session", x.topSessions[0] ? usd(x.topSessions[0].cost) : "—"],
    ["Total tokens", toks(x.totals.totalTokens), "≈ words read/written", toks(x.words)],
  ];
  for (const [k1, v1, k2, v2] of grid) {
    p(`  ${c.gray(padEnd(k1, 18))} ${padEnd(v1, 22)} ${c.gray(padEnd(k2, 18))} ${v2}`);
  }
  p();

  // ── reality checks ──────────────────────────────────────
  p("  " + hr(60));
  p();
  p(`  ${c.bold("REALITY CHECK")}`);
  p();
  p(`  ${c.ember("›")} You paid to re-read the same context ${c.bold(pct(x.rereadPct))} of all tokens — ${c.dim(toks(x.totals.cacheRead) + " tokens of déjà vu.")}`);
  if (x.topProjects[0] && x.projects > 1)
    p(`  ${c.ember("›")} ${c.bold(usd(x.topProjects[0].cost))} of it went into ${c.white("“" + x.topProjects[0].project + "”")} ${c.dim("(" + pct((x.topProjects[0].cost / total) * 100) + " of everything).")}`);
  const opus = x.models.find((m) => m.model === "Opus");
  if (opus) p(`  ${c.ember("›")} Opus alone was ${c.bold(pct((opus.cost / total) * 100))} of your bill ${c.dim("(" + usd(opus.cost) + ").")}`);
  const plan = meta.plan || 200;
  const mult = x.projectedMonthCost / plan;
  const flex = c.bold(c.green(mult.toFixed(0) + "× your money's worth"));
  if (mult >= 1.5)
    p(`  ${c.ember("›")} On a ${c.bold("$" + plan + "/mo")} plan you're on pace for ${flex} this month ${c.dim("— the API bill your flat plan is eating.")}`);
  else
    p(`  ${c.ember("›")} On API pricing this month would've cost you ${c.bold(usd(x.projectedMonthCost))}.`);
  p();

  // ── watchdog preview (own baseline) ─────────────────────
  if (x.anomalyRatio > 0 && x.priorDaily > 0) {
    p("  " + hr(60));
    p();
    const hot = x.anomalyRatio >= 1.5;
    const icon = hot ? c.red("▲") : x.anomalyRatio <= 0.6 ? c.green("▼") : c.gray("■");
    const word = hot ? c.red(x.anomalyRatio.toFixed(1) + "× your normal") : x.anomalyRatio <= 0.6 ? c.green((x.anomalyRatio).toFixed(1) + "× (quieter than usual)") : "in line with your usual";
    p(`  ${c.bold("WATCHDOG")}  ${icon}  Last 3 days are burning ${word}.`);
    p(`  ${c.dim("(" + usd(x.last3Daily) + "/day now vs " + usd(x.priorDaily) + "/day over the prior month.)")}`);
    if (hot) p(`  ${c.dim("Spikes like this are sometimes a caching bug or a runaway loop — worth a look.")}`);
    p();
  }

  // ── share card ──────────────────────────────────────────
  const card = [
    `${c.bold("My AI-coding spend, decoded 🔥")}`,
    ``,
    `${c.gray("API-equivalent value burned:")}  ${c.amber(usd(total))}`,
    `${c.gray("Claude actually writing code:")}  ${c.ember(gen.toFixed(gen < 1 ? 2 : 1) + "%")}  ${c.gray("of tokens")}`,
    `${c.gray("Spent re-reading context:")}      ${c.white(pct(x.rereadPct))}`,
    `${c.gray("This month → projected:")}        ${usd(x.thisMonthCost)} → ${usd(x.projectedMonthCost)}`,
    ``,
    `${c.gray("see yours:")}  ${c.cyan("npx vibeaudit")}`,
  ];
  p("  " + box(card, { title: c.ember("SHARE CARD"), color: c.gray, width: 52 }).split("\n").join("\n  "));
  p();

  // ── footer ──────────────────────────────────────────────
  if (meta.demo) p(`  ${c.amber("◆ demo data.")} ${c.dim("Run ")}${c.cyan("npx vibeaudit")}${c.dim(" to see your own real numbers.")}`);
  else p(`  ${c.green("🔒 100% local.")} ${c.dim("Read " + meta.fileCount.toLocaleString() + " log files on your machine. Nothing was uploaded. No account.")}`);
  p(`  ${c.dim("Costs are API-equivalent estimates — edit prices in src/pricing.js. Fable pricing is estimated.")}`);
  if (!meta.demo) p(`  ${c.gray("compare:")} ${c.dim("see how your spend ranks vs other devs (100% anonymous) →")} ${c.cyan("vibeaudit --compare")}`);
  p();

  return L.join("\n");
}
