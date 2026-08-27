# Project Status

Running work-log for the Floor Planner rebuild: what's done, what's next, and why each
piece was built the way it was — kept up to date so it doubles as a defense-ready record
of the project, not just a checklist.

See `docs/PLAN.md` for the full architecture and 15-day roadmap this tracks against.

## Day 1-2 — Repo scaffold + dataset mining

- [x] Repo structure created: `server/`, `client/`, `data-analysis/`, `docs/`
- [x] Server scaffolded: Express + Mongoose, ESM, `npm run dev` (Node's built-in
      `--watch`, no nodemon dependency needed on Node 22+)
- [x] Client scaffolded: Vite + React, `axios` / `react-router-dom` / `three` installed
- [ ] Local MongoDB: installed via winget (MongoDB Community 8.3), but `mongod.exe`
      currently fails to start with `STATUS_DLL_NOT_FOUND` even after installing the
      VC++ Redistributable. Not blocking code work (nothing needs a live DB yet) —
      revisit before the API/persistence milestone (Day 9-10). Options if it's still
      unresolved by then: clean reinstall (needs another admin-approved uninstall), or
      switch to MongoDB Atlas free tier.
- [x] `data-analysis/seed_stats.py` — mines ResPlan for room-frequency, adjacency-pair
      frequency, and size-ratio stats -> `rule-constants.seed.json`. Ran clean across
      all 17,000 plans. Sanity check: derived size ratios land close to the old
      project's hand-tuned `SIZE_RANGES` (e.g. bedroom p10-p90 0.105-0.215 vs their
      0.08-0.24), which is reassuring — real data roughly confirms the old hand-tuned
      guesses rather than contradicting them. Used p10/p90 instead of raw min/max as
      the range, since raw min/max includes degenerate near-zero outliers (bad source
      polygons, e.g. front_door min of 2e-17) that would break room sizing if used
      directly.

## Day 3-5 — Rule engine core
Not started.

## Day 6 — Rule engine batch testing
Not started.

## Day 7-8 — DXF export + 2D preview
Not started.

## Day 8-9 — Cost estimation
Not started.

## Day 9-10 — API + MongoDB wiring
Not started.

## Day 10-12 — React frontend
Not started.

## Day 13 — Integration pass
Not started.

## Day 14 — Report rewrite
Not started.

## Day 15 — Buffer / polish / defense prep
Not started.
