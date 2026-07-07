# vibeaudit compare server

Tiny Bun + `bun:sqlite` service backing `vibeaudit --compare`. Zero external deps.

- `POST /submit` — upsert one anonymous aggregate row (by random id), returns your percentiles.
- `POST /forget` — delete a row by id.
- `GET /stats` — cohort size + medians (JSON).
- `GET /` and `GET /u/:id` — the public comparison page.
- `GET /health`.

**Stores only anonymous aggregate numbers** (spend totals, %s, model mix). Never code, prompts, file
names, or IPs. Run: `PORT=7200 VIBEAUDIT_DB=./vibeaudit.db PUBLIC_BASE=https://vibeaudit.comsync.in bun server/server.js`.

_Not shipped in the npm package_ (excluded from `package.json` "files").

TODO before heavy public traffic: basic rate-limiting / sanity-filtering of submissions (anonymous
submit is spoofable — fine for launch, harden later).
