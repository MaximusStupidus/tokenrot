import fs from "node:fs";
import path from "node:path";
import { costOf } from "./pricing.js";

// Parse one jsonl file into usage records. Claude Code and Codex log usage in
// completely different shapes, so we branch by tool.
export function parseFile(file, tool) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const session = path.basename(file).replace(/\.jsonl$/, "");
  return tool === "Codex" ? parseCodex(raw, session) : parseClaude(raw, session, tool);
}

// Claude Code: one `message.usage` object per assistant turn.
function parseClaude(raw, session, tool) {
  const records = [];
  for (const line of raw.split("\n")) {
    if (line.length < 20 || line.indexOf('"usage"') === -1) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = o.message || o.response || o;
    const usage = msg && msg.usage;
    if (!usage) continue;

    const model = (msg.model || o.model || "unknown").toString();
    if (model.includes("synthetic")) continue; // internal, not billed

    const cc = usage.cache_creation || {};
    const u = {
      input: num(usage.input_tokens ?? usage.prompt_tokens),
      output: num(usage.output_tokens ?? usage.completion_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite5m: num(cc.ephemeral_5m_input_tokens),
      cacheWrite1h: num(cc.ephemeral_1h_input_tokens),
      webSearch: num(usage.server_tool_use && usage.server_tool_use.web_search_requests),
    };
    if (!u.cacheWrite5m && !u.cacheWrite1h) u.cacheWrite5m = num(usage.cache_creation_input_tokens);

    const totalTokens = u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
    if (totalTokens === 0) continue;

    const ts = o.timestamp || o.ts || msg.created_at || null;
    const cwd = o.cwd || o.csProject || null;
    records.push({ tool, session, model, ts: ts ? Date.parse(ts) : null, cwd, ...u, totalTokens, cost: costOf(model, u) });
  }
  return records;
}

// Codex rollout logs: token usage lives in `event_msg` lines with
// payload.type === "token_count", under payload.info.total_token_usage (a running
// cumulative). We take the highest cumulative as the session total → one record, no
// double-counting. cached_input_tokens is the cache-read; reasoning tokens fold into output.
function parseCodex(raw, session) {
  let model = "gpt-5-codex"; // ensures gpt pricing even if we can't read the exact model
  let cwd = null;
  let ts = null;
  let best = null;
  for (const line of raw.split("\n")) {
    if (line.length < 20) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const pl = o.payload || {};
    const m = pl.model || o.model || pl.info?.model;
    if (m) model = String(m);
    const c = pl.cwd || o.cwd;
    if (c) cwd = c;
    if (o.type === "event_msg" && pl.type === "token_count" && pl.info) {
      const tot = pl.info.total_token_usage || pl.info.last_token_usage;
      if (tot && isFinite(tot.total_tokens) && (!best || tot.total_tokens >= best.total_tokens)) {
        best = tot;
        ts = o.timestamp || ts;
      }
    }
    if (!ts && o.timestamp) ts = o.timestamp;
  }
  if (!best) return [];
  const cacheRead = num(best.cached_input_tokens); // OpenAI: input_tokens includes the cached portion
  const u = {
    input: Math.max(0, num(best.input_tokens) - cacheRead),
    output: num(best.output_tokens) + num(best.reasoning_output_tokens),
    cacheRead,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    webSearch: 0,
  };
  const totalTokens = u.input + u.output + u.cacheRead;
  if (totalTokens === 0) return [];
  return [{ tool: "Codex", session, model, ts: ts ? Date.parse(ts) : null, cwd, ...u, totalTokens, cost: costOf(model, u) }];
}

function num(v) {
  return typeof v === "number" && isFinite(v) ? v : 0;
}
