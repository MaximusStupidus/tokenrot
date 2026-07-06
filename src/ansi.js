// Zero-dependency ANSI helpers + box drawing. Degrades to plain text when NO_COLOR or non-TTY.

const enabled = process.env.NO_COLOR === undefined && process.env.FORCE_COLOR !== "0" && (process.stdout.isTTY || process.env.FORCE_COLOR);

const code = (open, close) => (s) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

export const c = {
  reset: enabled ? "\x1b[0m" : "",
  bold: code(1, 22),
  dim: code(2, 22),
  italic: code(3, 23),
  underline: code(4, 24),
  red: code(31, 39),
  green: code(32, 39),
  yellow: code(33, 39),
  blue: code(34, 39),
  magenta: code(35, 39),
  cyan: code(36, 39),
  white: code(37, 39),
  gray: code(90, 39),
  orange: code("38;5;208", 39),
  amber: code("38;5;214", 39),
  ember: code("38;5;202", 39),
  lime: code("38;5;154", 39),
  pink: code("38;5;205", 39),
  bgOrange: code("48;5;208;38;5;16", 49),
};

// strip ANSI for width math
export const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
export const width = (s) => stripAnsi(s).length;

export function padEnd(s, n) {
  const w = width(s);
  return w >= n ? s : s + " ".repeat(n - w);
}
export function padStart(s, n) {
  const w = width(s);
  return w >= n ? s : " ".repeat(n - w) + s;
}

// horizontal bar made of block chars, colored by a fn
export function bar(pct, len = 24, color = c.orange) {
  const filled = Math.max(0, Math.min(len, Math.round((pct / 100) * len)));
  return color("█".repeat(filled)) + c.gray("░".repeat(len - filled));
}

// a rounded box around lines, with an optional title
export function box(lines, { title = "", pad = 1, color = c.gray, width: boxW } = {}) {
  const inner = Math.max(boxW ?? 0, ...lines.map((l) => width(l))) + pad * 2;
  const top = color("╭" + (title ? ` ${title} ` : "") + "─".repeat(Math.max(0, inner - (title ? width(title) + 2 : 0))) + "╮");
  const bottom = color("╰" + "─".repeat(inner) + "╯");
  const body = lines.map((l) => color("│") + " ".repeat(pad) + padEnd(l, inner - pad * 2) + " ".repeat(pad) + color("│"));
  return [top, ...body, bottom].join("\n");
}

export const hr = (n = 62, color = c.gray) => color("─".repeat(n));
