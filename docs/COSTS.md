# How costs are computed

`burnrate` reports **API-equivalent cost** — what your usage *would* cost at pay-per-token API rates.
If you're on a flat subscription (Claude Max, Cursor Ultra, …), you pay far less; the gap is the point.

## The formula
For each message, cost (USD) =

```
( input        × price_in
+ output       × price_out
+ cache_read   × price_in × 0.10
+ cache_5m     × price_in × 1.25
+ cache_1h     × price_in × 2.00 ) / 1_000_000
```

Cache multipliers follow published Anthropic ratios: cache **read** ≈ 0.1× input, 5-minute cache
**write** ≈ 1.25× input, 1-hour cache **write** ≈ 2× input.

## The price table
Base per-million-token prices live in [`src/pricing.js`](../src/pricing.js) and are easy to edit:

| model | input ($/M) | output ($/M) | note |
|-------|-------------|--------------|------|
| Opus   | 15   | 75  | |
| Sonnet | 3    | 15  | |
| Haiku  | 0.80 | 4   | |
| Fable  | 6    | 30  | **estimated** — update when public |
| Codex/GPT | 2.5 | 10 | rough |

Model prices change often. If yours look off, edit the table — **PRs updating prices are very welcome.**

## Caveats
- These are estimates, not an invoice. Treat them as directional.
- `<synthetic>` internal messages are excluded (not billed).
- Server-side web search is billed at ~$10/1k requests where present.
