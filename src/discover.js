import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Find local agent session logs. Claude Code + Codex, on-device only.
export function discoverSources() {
  const home = os.homedir();
  const sources = [];

  const claudeRoot = path.join(home, ".claude", "projects");
  if (fs.existsSync(claudeRoot)) {
    sources.push({ tool: "Claude Code", root: claudeRoot, files: walk(claudeRoot, ".jsonl") });
  }
  const codexRoot = path.join(home, ".codex", "sessions");
  if (fs.existsSync(codexRoot)) {
    sources.push({ tool: "Codex", root: codexRoot, files: walk(codexRoot, ".jsonl") });
  }
  return sources.filter((s) => s.files.length > 0);
}

function walk(dir, ext, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, ext, acc);
    else if (e.isFile() && e.name.endsWith(ext)) acc.push(full);
  }
  return acc;
}
