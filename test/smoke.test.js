// Zero-dependency smoke test. Runs without any real logs. `npm test`.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { costOf, priceFor } from "../src/pricing.js";
import { parseFile } from "../src/parse.js";
import { computeInsights } from "../src/insights.js";

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log("  ✓ " + name); };

ok("priceFor matches models", () => {
  assert.equal(priceFor("claude-opus-4-8").in, 15);
  assert.equal(priceFor("claude-sonnet-4-6").in, 3);
  assert.equal(priceFor("claude-3-5-haiku").in, 0.8);
});

ok("costOf sums components", () => {
  const cost = costOf("claude-opus-4-8", { input: 1e6, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
  assert.equal(Math.round(cost), 15); // 1M input * $15/M
  const cr = costOf("claude-opus-4-8", { input: 0, output: 0, cacheRead: 1e6, cacheWrite5m: 0, cacheWrite1h: 0 });
  assert.ok(Math.abs(cr - 1.5) < 1e-6); // cache read = 0.1x input = $1.5
});

ok("parseFile reads a synthetic Claude line", () => {
  const tmp = path.join(os.tmpdir(), "tokenrot-test-" + Date.now() + ".jsonl");
  const line = JSON.stringify({
    type: "assistant",
    timestamp: new Date().toISOString(),
    cwd: "/Users/x/proj",
    message: { model: "claude-opus-4-8", usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 0 } } },
  });
  fs.writeFileSync(tmp, line + "\n" + '{"noise":true}\n');
  const recs = parseFile(tmp, "Claude Code");
  fs.unlinkSync(tmp);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].output, 50);
  assert.equal(recs[0].cacheRead, 1000);
  assert.ok(recs[0].cost > 0);
});

ok("computeInsights aggregates + derives", () => {
  const now = Date.now();
  const recs = [
    { tool: "t", session: "s1", model: "Opus", ts: now, cwd: "/a/proj1", input: 100, output: 10, cacheRead: 5000, cacheWrite5m: 100, cacheWrite1h: 0, webSearch: 0, totalTokens: 5210, cost: 5 },
    { tool: "t", session: "s2", model: "Sonnet", ts: now - 5 * 86400000, cwd: "/a/proj2", input: 200, output: 90, cacheRead: 1000, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0, totalTokens: 1290, cost: 1 },
  ];
  const x = computeInsights(recs);
  assert.equal(x.records, 2);
  assert.equal(x.sessions, 2);
  assert.ok(x.totals.cost === 6);
  assert.ok(x.generationPct > 0 && x.generationPct < 100);
  assert.equal(x.models[0].model, "Opus"); // sorted by cost desc
  assert.ok(x.rereadPct > 50); // cache-read heavy
});

console.log(`\n  ${passed} checks passed.\n`);
