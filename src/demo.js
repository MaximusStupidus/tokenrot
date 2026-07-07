import { costOf } from "./pricing.js";

// Deterministic synthetic usage — for --demo and the README image. Never touches real logs.
export function demoRecords() {
  let seed = 1337;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

  const DAY = 86400000;
  const now = Date.now();
  const projects = ["/home/dev/my-saas", "/home/dev/side-project", "/home/dev/scripts"];
  const recs = [];

  for (let d = 37; d >= 0; d--) {
    const dayStart = now - d * DAY;
    const recent = d <= 2; // last 3 days run hotter (drives the watchdog line)
    const sessions = 8 + Math.floor(rnd() * (recent ? 18 : 12));
    for (let s = 0; s < sessions; s++) {
      const session = `sess-${d}-${s}`;
      const cwd = rnd() < 0.62 ? projects[0] : pick(projects);
      const msgs = 12 + Math.floor(rnd() * 44);
      for (let m = 0; m < msgs; m++) {
        const model = rnd() < 0.9 ? "claude-opus-4-8" : rnd() < 0.8 ? "claude-sonnet-4-6" : "claude-haiku-4-5";
        const cacheRead = Math.floor((10000 + rnd() * 70000) * (recent ? 1.5 : 1));
        const cacheWrite5m = Math.floor(rnd() * 8000);
        const cacheWrite1h = rnd() < 0.3 ? Math.floor(rnd() * 12000) : 0;
        const input = 60 + Math.floor(rnd() * 500);
        const output = 40 + Math.floor(rnd() * 900);
        const u = { input, output, cacheRead, cacheWrite5m, cacheWrite1h, webSearch: 0 };
        recs.push({
          tool: "Claude Code",
          session,
          model,
          ts: dayStart + Math.floor(rnd() * DAY),
          cwd,
          ...u,
          totalTokens: input + output + cacheRead + cacheWrite5m,
          cost: costOf(model, u),
        });
      }
    }
  }
  return recs;
}
