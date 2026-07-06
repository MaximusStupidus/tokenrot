# burnrate

**The truth about your AI-coding spend.** One command shows where your Claude Code / Codex
tokens and money *actually* go — and it runs 100% on your machine.

```bash
npx burnrate
```

No signup. No API key. No upload. It just reads the usage metadata already sitting in your
local logs and prints the receipts.

---

```
   burnrate   the truth about your AI-coding spend

  Across 41,300 messages in 890 sessions, Claude was actually
  writing code 0.5% of the time.  The other 99.5% was reading context.

  You've burned  $9,240 in API-equivalent value over 38 days.

  ────────────────────────────────────────────────────────────
  WHERE YOUR TOKENS WENT   (by volume)

  Re-reading old context █████████████████████░   95%  3.9B   cache read
  Loading new context    █░░░░░░░░░░░░░░░░░░░░░  3.6%  148M   cache write
  Your prompts           ░░░░░░░░░░░░░░░░░░░░░░  0.4%  16M    input
  Claude writing code    ░░░░░░░░░░░░░░░░░░░░░░  0.5%  22M    output ← the actual work

  ────────────────────────────────────────────────────────────
  REALITY CHECK

  › You paid to re-read the same context 95% of all tokens.
  › Opus alone was 96% of your bill.
  › On a $200/mo plan you're on pace for 40× your money's worth this month.

  WATCHDOG  ▲  Last 3 days are burning 1.8× your normal.
```

## Why

If you're one of the people paying $100–600/month for Claude Code, Cursor, or Codex, you've
probably wondered: *am I getting my money's worth? did it get slower this week? where is all
this going?* `burnrate` answers that from your own data — no dashboards to log into, nothing
leaving your laptop.

The number most people don't believe until they see it: **the model is only "writing" for a
fraction of a percent of your tokens.** Almost everything you pay for is re-reading context.

## Privacy

- **Your code and prompts never leave your machine.** Full stop.
- It reads token/usage *metadata* (counts, timestamps, model names) from files already on disk:
  - `~/.claude/projects/**/*.jsonl` (Claude Code)
  - `~/.codex/sessions/**/*.jsonl` (Codex)
- **Zero runtime dependencies.** The whole thing is a few short files you can read in a minute.
- No network calls. No account. No telemetry.

## Usage

```bash
npx burnrate                 # full report
npx burnrate --since 7       # just the last 7 days
npx burnrate --plan 100      # value math against your plan ($100 Max, etc.)
npx burnrate --json          # raw numbers, for scripting
npx burnrate --no-color      # plain text
```

## Notes

- Costs are **API-equivalent estimates** — what your usage would cost at pay-per-token API
  rates. If you're on a flat subscription you're paying far less; that's the point (the "value"
  or the runaway bill your plan is absorbing). Edit the table in `src/pricing.js` to match
  current rates.
- Newer/rarer models (e.g. Fable) use estimated pricing until rates are public.

## Roadmap

`burnrate` is the free, local starting point. Coming next: an opt-in way to see whether **you're
being throttled, downgraded, or overcharged compared to everyone else** — the independent
watchdog for the tools you pay for. (Only anonymous token/timing numbers, never your code.)

## License

MIT
