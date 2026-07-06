import fs from "node:fs";
import path from "node:path";
import { costOf } from "./pricing.js";

// Parse one jsonl file into usage records. Handles Claude Code + Codex shapes defensively.
export function parseFile(file, tool) {
  const records = [];
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return records;
  }
  const session = path.basename(file).replace(/\.jsonl$/, "");
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
    // fallback: if no split cache_creation, treat total cache_creation as 5m
    if (!u.cacheWrite5m && !u.cacheWrite1h) u.cacheWrite5m = num(usage.cache_creation_input_tokens);

    const totalTokens = u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
    if (totalTokens === 0) continue;

    const ts = o.timestamp || o.ts || msg.created_at || null;
    const cwd = o.cwd || o.csProject || null;

    records.push({
      tool,
      session,
      model,
      ts: ts ? Date.parse(ts) : null,
      cwd,
      ...u,
      totalTokens,
      cost: costOf(model, u),
    });
  }
  return records;
}

function num(v) {
  return typeof v === "number" && isFinite(v) ? v : 0;
}
