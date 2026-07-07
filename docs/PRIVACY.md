# Privacy

`tokenrot` is designed so that **your code and prompts never leave your machine.**

## What it reads
Only local files that already exist on disk:
- `~/.claude/projects/**/*.jsonl` — Claude Code session logs
- `~/.codex/sessions/**/*.jsonl` — Codex session logs

From each log line it extracts **usage metadata only**: token counts
(`input`, `output`, `cache_read`, `cache_creation`), the model name, and the timestamp. It does
**not** read, store, or transmit the message content, your prompts, or your code — even though that
content sits in the same files.

## What it sends
**Nothing.** `tokenrot` makes zero network requests. There is no account, no API key, no telemetry,
no "anonymous analytics." You can confirm this two ways:
1. Read the source — it's ~500 lines with **zero runtime dependencies**. Search it for `fetch`,
   `http`, `net`, `dns` — there are none.
2. Run it offline (turn off your wifi). It works exactly the same.

## The future "watchdog" tier
The roadmap includes an **opt-in** feature to compare your usage against other users (to detect
throttling/regressions network-wide). If and when that ships:
- It is **off by default** and requires explicit opt-in.
- It sends only **anonymous numbers** — token counts, timings, throttle events — **never** your code,
  prompts, file names, or project paths.
- The free local tool will always remain fully useful with sharing turned off.

## Reporting a concern
See [SECURITY.md](../SECURITY.md).
