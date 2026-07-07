<div align="center">

# burnrate

### The truth about your AI-coding spend.

One command shows where your **Claude Code** & **Codex** tokens and money *actually* go.
Runs 100% on your machine — no signup, no API key, nothing uploaded.

[![npm](https://img.shields.io/npm/v/burnrate?color=ff6a2b&label=npm)](https://www.npmjs.com/package/burnrate)
[![CI](https://github.com/MaximusStupidus/burnrate/actions/workflows/ci.yml/badge.svg)](https://github.com/MaximusStupidus/burnrate/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![node](https://img.shields.io/badge/node-%E2%89%A518-3fd07f)
![local](https://img.shields.io/badge/%F0%9F%94%92-100%25%20local-3fd07f)
![deps](https://img.shields.io/badge/dependencies-0-brightgreen)

```bash
npx burnrate
```

<img src="https://raw.githubusercontent.com/MaximusStupidus/burnrate/main/docs/demo.svg" alt="burnrate output" width="720">

</div>

---

## The one stat nobody believes

Across tens of thousands of messages, the model is only *"writing"* for **well under 1%** of your
tokens. Almost everything you pay for is **re-reading the same context over and over.** `burnrate`
computes that from your own logs and shows you the receipts — the model breakdown, the projected
month, the priciest project, and a watchdog line that flags when your burn spikes above *your* normal.

## Features

- 🔥 **The shock stat** — what % of your tokens were the model actually generating vs. re-reading context.
- 💸 **Where the money went** — cost broken down by model (Opus / Sonnet / Haiku / …) and by project.
- 📈 **This month → projected** — and how many multiples of your flat plan you're really using.
- 🐕 **Watchdog (own baseline)** — "last 3 days are burning 1.6× your normal" — catches runaway loops & caching bugs.
- 🧾 **A share card** — the bottom of the report is designed to be screenshotted straight to Reddit/X.
- 🔒 **100% local, 0 dependencies** — reads files already on your disk; nothing leaves your machine.

## Privacy (the whole point)

Your **code and prompts never leave your machine. Full stop.** `burnrate` only reads token/usage
*metadata* — counts, timestamps, model names — from logs already on disk:

| tool | path |
|------|------|
| Claude Code | `~/.claude/projects/**/*.jsonl` |
| Codex | `~/.codex/sessions/**/*.jsonl` |

- **Zero runtime dependencies** — the entire thing is ~500 lines you can read in a minute.
- **No network calls. No account. No telemetry.**

More detail: [docs/PRIVACY.md](docs/PRIVACY.md).

## Usage

```bash
npx burnrate                 # full report
npx burnrate --since 7       # only the last 7 days
npx burnrate --plan 100      # value math vs your plan ($100 Max, $200 Ultra, …)
npx burnrate --json          # raw numbers, for scripting
npx burnrate --demo          # synthetic data (for screenshots / trying it out)
npx burnrate --no-color      # plain text (or set NO_COLOR=1)
npx burnrate --help
```

Install it if you run it often:

```bash
npm i -g burnrate && burnrate
```

## How the numbers are computed

Costs are **API-equivalent estimates** — what your usage *would* cost at pay-per-token API rates. If
you're on a flat subscription you're paying far less; that gap is exactly the point (the "value" you're
getting, or the runaway bill your plan is absorbing).

Full method, and the editable price table, are in [docs/COSTS.md](docs/COSTS.md). TL;DR: cache reads are
priced at 0.1× input, cache writes at 1.25×–2×, and rarer/newer models (e.g. Fable) use estimated rates
until they're public — tweak `src/pricing.js` to match reality.

## FAQ

**Does this send my code anywhere?** No. It reads local metadata and prints to your terminal. There are
zero network calls and zero dependencies — verify it yourself, it's a handful of small files.

**I'm on a flat plan, why does it show thousands of dollars?** That's the *API-equivalent* value — what
you'd pay per-token. On a flat plan you're capped far below it. Seeing the gap is the feature.

**The dollar amounts look off.** They're estimates from a price table you can edit in `src/pricing.js`.
Model prices change; PRs welcome.

**Does it work with Cursor / Windsurf / others?** Claude Code and Codex today. More tools are on the roadmap.

## Roadmap

`burnrate` is the free, local starting point. Coming next: an **opt-in** way to see whether **you're being
throttled, downgraded, or overcharged compared to everyone else** — the independent watchdog for the tools
you pay for. Only anonymous token/timing numbers are ever shared, never your code.

## Contributing

Issues and PRs welcome — especially price-table updates and support for more tools. See
[CONTRIBUTING.md](CONTRIBUTING.md). Run the tests with `npm test`.

## License

[MIT](LICENSE)
