# Contributing

Thanks for helping make `vibeaudit` better.

## Quick start
```bash
git clone https://github.com/MaximusStupidus/vibeaudit
cd vibeaudit
node bin/vibeaudit.js        # run against your own logs
node bin/vibeaudit.js --demo # run against synthetic data
npm test                    # smoke tests (no real logs needed)
```

## Ground rules
- **Zero runtime dependencies.** This is a hard constraint — it's core to the trust/privacy promise.
  Please don't add npm dependencies.
- **Nothing leaves the machine.** No network calls in the CLI.
- Keep files small and focused; match the existing style (plain ESM, `node:`-prefixed builtins).

## The most useful PRs
- **Price-table updates** in `src/pricing.js` when model rates change.
- **New tool support** (Cursor, Windsurf, Gemini CLI, etc.) — add a source in `src/discover.js` and,
  if the log shape differs, handle it in `src/parse.js`.
- Bug fixes with a repro. New insights that are genuinely shareable.

## Regenerating the demo image
```bash
npm run gen-demo   # writes docs/demo.svg from --demo output
```

Please add/adjust a check in `test/smoke.test.js` for anything non-trivial.
