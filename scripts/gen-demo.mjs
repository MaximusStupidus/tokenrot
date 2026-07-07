#!/usr/bin/env node
// Render `vibeaudit --demo` and convert the ANSI output into a self-contained SVG "terminal screenshot".
// Usage: node scripts/gen-demo.mjs > docs/demo.svg
import { execSync } from "node:child_process";

const raw = execSync("node bin/vibeaudit.js --demo", { env: { ...process.env, FORCE_COLOR: "1" } }).toString();

// 256-color / basic ANSI → hex (only the palette vibeaudit uses)
const C256 = { 16: "#0b0d12", 154: "#afff00", 202: "#ff5f00", 205: "#ff5faf", 208: "#ff8700", 214: "#ffaf00" };
const BASIC = { 31: "#f2555a", 32: "#3fd07f", 33: "#e6c07b", 34: "#61afef", 35: "#c678dd", 36: "#5ad1e0", 37: "#e6e6e6", 90: "#7a8290", 39: "#d6dae2" };

function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// parse ANSI into styled runs
const lines = raw.replace(/\r/g, "").split("\n");
let maxLen = 0;
const parsed = lines.map((line) => {
  const runs = [];
  let fg = "#d6dae2", bold = false, dim = false, bg = null;
  let i = 0, plainLen = 0;
  const re = /\x1b\[([0-9;]*)m/g;
  let m, last = 0;
  const push = (txt) => { if (!txt) return; runs.push({ txt, fg: bg || fg, bold: bold || !!bg, dim, }); plainLen += txt.length; };
  while ((m = re.exec(line))) {
    push(line.slice(last, m.index));
    last = re.lastIndex;
    const codes = m[1].split(";").filter((x) => x !== "");
    for (let k = 0; k < codes.length; k++) {
      const code = codes[k];
      if (code === "0" || code === "") { fg = "#d6dae2"; bold = dim = false; bg = null; }
      else if (code === "1") bold = true;
      else if (code === "22") { bold = false; dim = false; }
      else if (code === "2") dim = true;
      else if (code === "3" || code === "4" || code === "23" || code === "24") {}
      else if (code === "38" && codes[k + 1] === "5") { fg = C256[codes[k + 2]] || fg; k += 2; }
      else if (code === "48" && codes[k + 1] === "5") { bg = C256[codes[k + 2]] || "#ff8700"; k += 2; }
      else if (code === "49") bg = null;
      else if (BASIC[code]) fg = BASIC[code];
      else if (code === "39") fg = "#d6dae2";
    }
  }
  push(line.slice(last));
  maxLen = Math.max(maxLen, plainLen);
  return runs;
});

const CW = 8.0, LH = 18.5, padX = 22, padY = 40;
const W = Math.ceil(padX * 2 + maxLen * CW);
const H = Math.ceil(padY + lines.length * LH + 18);

let body = "";
parsed.forEach((runs, li) => {
  const y = (padY + li * LH).toFixed(1);
  let x = padX, spans = "";
  for (const r of runs) {
    const style = `fill="${r.fg}"${r.bold ? ' font-weight="700"' : ""}${r.dim ? ' opacity="0.62"' : ""}`;
    spans += `<tspan xml:space="preserve" x="${x.toFixed(1)}" y="${y}" ${style}>${esc(r.txt)}</tspan>`;
    x += r.txt.length * CW;
  }
  if (spans) body += spans;
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="13">
  <rect width="${W}" height="${H}" rx="12" fill="#0a0c11"/>
  <rect width="${W}" height="26" rx="12" fill="#11141b"/><rect y="14" width="${W}" height="12" fill="#11141b"/>
  <circle cx="18" cy="13" r="5" fill="#ff5f57"/><circle cx="36" cy="13" r="5" fill="#febc2e"/><circle cx="54" cy="13" r="5" fill="#28c840"/>
  <text>${body}</text>
</svg>`;
process.stdout.write(svg);
