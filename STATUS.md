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

**Status: Done (reviewed and closed out).**

Implemented (built by `builder`). All files under
`server/src/ruleEngine/`, plain ESM JS, no new dependencies, heavily
commented (every function/block explains what it does and why, per the
"viva-ready" requirement) since this is the technical core of the project:

- `constants.js` - loads `data-analysis/output/rule-constants.seed.json` at
  module load time, exports `ROOM_TYPES` (drops `stair` - out of scope, same
  MVP decision the old project made), `SIZE_RANGES` (min/target/max per type
  from the seed's p10/median/p90), `PRIORITY` (settling order: living 100 >
  bedroom 85 > bathroom 70 > kitchen 60 > storage 40 > balcony 25 >
  front_door 10).
- `roomProgram.js` - `buildRoomProgram(requirements)`: validates/defaults
  requirement counts (at least 1 living/bedroom/bathroom, exactly 1
  front_door always, negative counts throw) and returns the flat room list.
- `attachMap.js` - `buildAttachMap(rooms)`: bedroom<->bathroom pairing
  (master-first en-suite if bathrooms >= bedrooms, otherwise ALL bathrooms
  become shared hall bathrooms off living rather than giving only some
  bedrooms an en-suite), kitchen/storage/balcony/front_door attach rules per
  the plan. Documented deviation: "master" bedroom is ranked by declaration
  order, not predicted size, since sizing happens later here (no model).
- `plotSizing.js` - `estimatePlotDimensions(rooms)`: nominal area + a
  unit-to-metres conversion factor from `SIZE_RANGES.min` totals vs the
  0.82 usable-plot fraction; real plot width/depth are resolved later by
  solver.js, from the actual solved layout's extent.
- `seeding.js` - **the new stage this project needed that the old
  ML+corrector project never did**: `seedLayout(rooms, attachMap)` produces
  a rough, not-necessarily-collision-free first placement, priority-ordered
  zone by zone (living at the front, bedroom row behind it, everything else
  placed beside its attach target).
- `solver.js` - `solveLayout(seededRooms, attachMap, { maxIterations })`:
  priority-ordered minimal-movement relaxation with a 3-tier lexicographic
  cost (collision severity > relationship satisfaction > distance from the
  *seeded* position - replacing the old project's "distance from the ML
  prediction" term), a collision safety-net pass, and final plot
  width/depth/area measured from the solved layout's bounding box.
- `validate.js` - `validateLayout(solvedRooms, attachMap)`: read-only
  checklist (no overlaps, front door exterior + near living, kitchen
  adjacent to living, balconies exterior, en-suite pairs adjacent, living
  not oversized).
- `demo.js` - runnable smoke test (`node server/src/ruleEngine/demo.js`),
  confirmed working, output below.

**Design decisions worth flagging for review:**

- *Exterior check heuristic.* There's no fixed plot boundary anywhere in
  this pipeline (plot size is only measured after solving), so
  "touches an exterior edge" can't mean "touches a pre-drawn wall". Went
  through two versions during testing: v1 compared a room's edge against
  the layout's single overall bounding box, which turned out to be wrong -
  it made two *different* exterior rooms on the same general side of the
  house (e.g. the front door and a second balcony, both facing the front)
  incorrectly compete, even when they didn't share any footprint and
  neither actually blocked the other. Replaced with a per-side "shadow
  test" (`isSideExterior` in both solver.js and validate.js): a wall is
  exterior if nothing sharing its span stands beyond it. Verified this
  fixes the specific case found in testing (see below) without regressing
  anything else.
- *Priority-aware collision reaction.* The first working version let *any*
  room react to *any* collision on its own turn, regardless of whether the
  other room was more or less architecturally important. In testing this
  let a low-priority room (e.g. the front door, seeded slightly overlapping
  living by design) drag a *high*-priority room (living itself) out of
  position simply because of processing order within a pass. Fixed by
  making a room only treat a collision as its own problem when the other
  room is equal-or-higher priority (`isRelevantCollider` in solver.js) -
  matches the same principle the collision safety net already used
  explicitly, just applied throughout the main loop too, not only at the
  end.
- *Seeding placement conflicts.* Testing surfaced a few cases where the
  simple "place beside the attach target" seeding rule put two different
  rooms in the same spot (e.g. storage placed "beside kitchen" landing
  inside *living*'s footprint when kitchen is small and living is large; an
  en-suite bathroom placed "beside its bedroom" landing on top of the
  *next* bedroom in the row, since bedrooms are seeded with no gap reserved
  for their bathrooms; storage and shared-hall bathrooms both defaulting to
  living's right side when there's no kitchen). Fixed by choosing
  directions that route rooms *away* from the layout instead of back
  toward an already-crowded neighbour (en-suite bathrooms go behind their
  bedroom, not beside it; storage always goes left of its target, never the
  same side shared-hall bathrooms use). Each fix is commented in
  `seeding.js` with the specific scenario it addresses.

**Verification performed (manual, ad-hoc - Day 6 is where this becomes a
real committed batch test):**

- `node server/src/ruleEngine/demo.js` runs end-to-end successfully (3
  bedrooms / 2 bathrooms / 1 kitchen / 1 living / 1 balcony / 1 storage) -
  all 7 validation checks pass, plot resolves to ~16.1m x 12.2m
  (~196.65 m^2).
- A one-off sweep across 672 synthetic single-living-room requirement
  combinations (bedrooms 1-6, bathrooms 0-6, kitchens 0-1, balconies 0-3,
  storages 0/2) passed 640/672 (95.2%) on the first builder pass. See the
  fixer pass below for the re-run numbers after both findings were fixed.

**Fixer pass - both checker-diagnosed findings resolved (or substantially
resolved - see updated open issues below):**

- *Finding 1 fix - `livingNotOversized` scaling.* The checker's diagnosis
  was correct and precise: `SIZE_RANGES.living.{min,target,max}` are
  living's share of a plan's TOTAL built area, mined across 17,000 real
  plans that average `AVG_OTHER_ROOMS_PER_PLAN` (~8.2, now computed in
  `constants.js` straight from `seed.room_type_frequency` rather than
  hand-picked) non-living rooms each. Comparing that one flat fraction
  against every room program regardless of its own room count was
  comparing against the wrong baseline for anything far from that average.
  Since neither `seeding.js` nor `solver.js` ever resizes a room after
  it's first placed (every room is always exactly its
  `SIZE_RANGES[type].target` fraction, fixed at seed time), the fix models
  a plan's total built area as `L + k * (other room count)` - living's
  area (`L`) fixed, every other room's average area (`k`) fixed - solves
  `datasetMaxFraction = L / (L + k * AVG_OTHER_ROOMS_PER_PLAN)` for `k`
  using the dataset's own mined p90, then re-solves that same relationship
  for the ACTUAL program's own other-room count. This gives a threshold
  that scales with room count instead of staying flat: it loosens for
  small programs (fewer other rooms -> living's natural share rises, e.g.
  the checker's 4-room case: expected max ~0.78 vs a raw living fraction
  of 0.645, now a clean pass) and correctly TIGHTENS for large ones (many
  other rooms -> a living room still eating the dataset's "typical" share
  really would be oversized). See `constants.js` (`AVG_OTHER_ROOMS_PER_PLAN`)
  and `validate.js` (check 7) for the full derivation in comments.
- *Finding 2 fix - multi-living seeding collision.* The checker's traced
  mechanism was reproduced in isolation (confirmed `noOverlaps: false` with
  the original seeding code, isolated from any validate.js change) and
  matched exactly: extra living rooms (index >= 1) were seeded immediately
  right of `living_0`, the same corridor shared "hall" bathrooms attach to
  off living's right side, and neither could be forced to yield to the
  other. Fixed in `seeding.js`'s living-placement block: only the main
  living room (typeIndex 0) is placed in the front row; every extra living
  room is now placed BEHIND `living_0` (the "back" side, the same relative
  direction an en-suite bathroom uses behind its bedroom) - a corridor
  bathrooms never route through, since a bathroom only ever goes "right"
  of living or "back" of a bedroom, never "back" of living itself.
  `livingRowBottomY` (where the bedroom row starts) now accounts for
  extra livings' extent too, so the bedroom row still starts clear of the
  whole living zone, not just `living_0`.

**Fresh batch sweep (post-fix, fixer's own run):**

- Single-living sweep (same 672 combos as the builder's original sweep):
  **664/672 passed (98.8%)**, up from 640/672 (95.2%). All 8 remaining
  failures are `livingNotOversized` only (zero overlap/exterior/adjacency
  failures) - every one is an extreme, unrealistic mix (1 bedroom + 4-6
  bathrooms, no kitchen): the fix's room-COUNT-based dilution model
  assumes an average-sized "other" room, but a program skewed toward many
  small bathrooms and almost no bedrooms has less actual "other" area than
  that average predicts, so living's share stays a bit above the scaled
  threshold. A real limitation of using a single scalar room-count proxy
  instead of a full per-type area model - understood, not a placement bug,
  and left as-is rather than over-fit to these 8 unrealistic combos (see
  updated open issues below).
- Multi-living sweep (192 combos, 2-3 living rooms, sampled across
  bedrooms/bathrooms/kitchens/balconies/storages): **19/192 passed
  (9.9%)**. `noOverlaps` failures dropped from **176/192 (91.7%) to 16/192
  (8.3%)** after the seeding fix - a real, large improvement, but not a
  complete fix (see updated open issue #2 below). `livingNotOversized`
  fails in 173/192 (90.1%) - confirmed via a controlled before/after
  comparison to be UNRELATED to the seeding fix (identical 173/192 count
  with both the original and fixed seeding code): every extra living room
  is sized at the SAME full "median single living room" target area as
  `living_0` (see `sizeOf()` in `seeding.js`), so 2-3 living rooms very
  quickly dominate a program's total area. This is a pre-existing sizing
  characteristic of the multi-living extension itself (`attachMap.js`'s
  "extra living rooms attach to the main one" rule, added for completeness
  beyond the literal spec), not something either checker finding asked to
  be fixed - flagged as a new open issue below rather than fixed here.
- The checker's exact failing scenario (5 bedrooms/3 bathrooms/2 living
  rooms/3 balconies/2 storage rooms) now has `noOverlaps: true` (was
  `false`) - Finding 2 is resolved for this exact case. It does now fail
  `livingNotOversized` (livingFraction 0.383 vs a scaled threshold of
  ~0.343) - confirmed via the same before/after comparison to be entirely
  a consequence of the Finding 1 formula being more accurate (it would
  have passed under the OLD flat threshold too), not a regression from the
  seeding fix, and not something looser-toleranced away without
  undermining Finding 1's whole point. The single-living-room version of
  the same requirements (5/3/1/3/2) passes cleanly with no regression.

**Known open issues:**

1. `livingNotOversized` false positives on extreme, unrealistic single-living
   programs (1 bedroom + 4-6 bathrooms, no kitchen - 8/672 in the sweep
   above). The room-count-based scaling fix resolves the general small-vs-large
   program problem the checker diagnosed, but still assumes an "average-sized"
   other room; a program whose other rooms are unusually small on average
   (many bathrooms, almost no bedrooms/kitchen) will still read as slightly
   over the scaled threshold. Low priority - these are not realistic user
   requests.
2. Multi-living seeding collisions are substantially, not completely, fixed:
   `noOverlaps` failures dropped from 176/192 to 16/192 in the sweep above.
   The residual 16 are all 3-living-room programs combined with 4+ bathrooms
   that ALL attach to living as shared "hall" bathrooms (either bathrooms far
   outnumbering bedrooms, e.g. 6 bathrooms/1 bedroom, or bathrooms short of
   bedrooms so every bathroom becomes a hall bathroom, e.g. 4 bathrooms/5
   bedrooms) - the stacked hall-bathroom column off living_0's right side
   grows long enough, with that many bathrooms queued on it, to reach into
   the y-band the extra living rooms now occupy behind living_0. Needs
   either a taller safety margin behind living_0, a second stacking column
   for hall bathrooms, or a solver iteration-budget increase - deliberately
   left unfixed here as a distinct, narrower problem from what was diagnosed
   (an invasive change beyond the smallest fix for the exact finding handed
   over).
3. NEW (surfaced by this fixer pass, not part of either original finding):
   multiple living rooms make `livingNotOversized` fail on the large
   majority (173/192, 90.1%) of sampled multi-living programs, because
   `seeding.js`'s `sizeOf()` gives every extra living room the same full
   median-single-living-room target area as the main one, so 2-3 living
   rooms combined very quickly dominate total area regardless of placement.
   This is a sizing-model gap in the multi-living extension itself (not a
   placement bug, and not something either checker finding covered) - worth
   a decision next: give extra living rooms a smaller dedicated size ratio,
   or treat "multiple living rooms" as genuinely out of scope beyond the
   plan's literal spec.

**Reviewer close-out (Day 3-5):**

Verified independently rather than taking the fixer's final numbers on
trust: read all 8 files in `server/src/ruleEngine/` end to end, ran
`node server/src/ruleEngine/demo.js` fresh (still passes all 7 checks,
plot ~16.1m x 12.2m as claimed), and re-ran a fresh batch sweep (see Day 6
below) that independently reproduced 664/672 (98.8%), zero
overlap/exterior/adjacency failures - the fixer's reported numbers hold up.

**Scope decision: `livingRooms` capped at exactly 1** (`roomProgram.js`,
Step 2b). This was mine to make, not just report on, per the open question
handed to this review pass. Reasoning:

- `docs/PLAN.md` and the underlying report only ever require a single
  "living area" per home. Multi-living-room support (a second/third
  lounge, each attaching to the main one via `attachMap.js`) was the
  builder's own extension beyond the literal spec, noted as such in
  STATUS.md at the time it was added.
- The real dataset agrees this isn't something real users ask for:
  `data-analysis/output/rule-constants.seed.json` shows 16,999 of the
  17,000 real ResPlan plans it was mined from have exactly 1 living room
  (`room_type_frequency.living` vs `plan_count`) - checked directly, not
  taken on faith.
- Multi-living support was also the source of every remaining problem in
  this milestone: the residual seeding collision (open issue #2, 16/192)
  only happens with 3+ living rooms, and the new sizing gap (open issue #3,
  90.1% failure rate on `livingNotOversized`) only happens because extra
  living rooms exist at all. Both are real, understood mechanisms, not
  mysteries - but fixing either one properly (a second stacking column for
  hall bathrooms; a dedicated smaller size ratio for extra living rooms)
  is real, uncosted work this milestone's budget didn't include.
- With 15 days total and DXF export, cost estimation, the API, the
  frontend, and the report rewrite all still ahead, spending more time
  chasing edge cases in a feature real users won't exercise isn't a good
  trade. Capping removes open issues #2 and #3 entirely (the situation
  that causes them can no longer be requested through `buildRoomProgram`,
  the only user-input entry point) rather than leaving them as known gaps
  to explain later.
- The downstream multi-living code (`attachMap.js`'s "extra livings attach
  to the main one" rule, `seeding.js`'s "extra livings placed behind
  `living_0`" block) is left in place rather than deleted - it's harmless
  since it's now unreachable through normal input, and it's a real,
  working starting point if multi-living is ever wanted post-MVP.

Implemented as a one-line cap in `roomProgram.js`
(`counts.livingRooms = Math.min(1, counts.livingRooms)`), with the reasoning
above written directly into the code comment there so it's not a silent
change. Verified: requesting `livingRooms: 3` now produces exactly 1
`living_*` room in the program and the resulting plan still passes
validation (see `batch.test.mjs`'s second test, Day 6 below).

**Known open issues, updated after the cap:**

1. `livingNotOversized` false positives on extreme, unrealistic
   single-living programs (1 bedroom + 4-6 bathrooms, no kitchen -
   8/672, 1.2%, in the committed sweep below). Unchanged by the cap
   (it already only affected single-living programs) - low priority,
   not realistic user requests, accepted as a documented statistical
   edge case rather than a placement bug.
2. ~~Multi-living seeding collision~~ and 3. ~~multi-living oversized~~ -
   both **resolved by the scope cap above**, not by further debugging:
   since `livingRooms` can no longer exceed 1 through the only real entry
   point (`buildRoomProgram`), the room-count combinations that triggered
   either issue can no longer occur in the shipped product. Multi-living
   support itself remains documented future work, not a bug to revisit.

## Day 6 — Rule engine batch testing

**Status: Done.**

The Day 3-5 builder/checker/fixer cycle already did the substance of what
Day 6 asks for - collision rate, boundary compliance, and rule-satisfaction
rate, measured across multiple independent sweeps of hundreds of synthetic
requirement combinations, with per-check failure breakdowns. What it hadn't
done yet was leave anything reusable behind: every sweep so far lived in a
scratch script thrown away at the end of that agent's own turn, per each
one's own account in this file. Re-running the same evidence by hand every
time the rule engine changes isn't a real regression safety net.

Closed that gap by writing `server/src/ruleEngine/__tests__/batch.test.mjs`
- a real, committed test file, not another scratch script - using Node's
built-in `node:test` + `node:assert` (zero new dependencies, matching the
rest of this codebase). Wired into `npm test` (`server/package.json`).
Three checks:

1. A fast single-case smoke test (same requirements as `demo.js`) that
   fails immediately and specifically if something fundamental breaks,
   before the slower sweep runs.
2. A regression check on the Day 3-5 scope cap: requesting `livingRooms: 3`
   must produce exactly 1 living room and still validate cleanly.
3. The batch sweep itself - the same 672-combination grid (bedrooms 1-6 x
   bathrooms 0-6 x kitchens 0-1 x balconies 0-3 x storages 0/2) the
   checker/fixer used during Day 3-5, run fresh through the full pipeline
   (`buildRoomProgram` -> `buildAttachMap` -> `seedLayout` -> `solveLayout`
   -> `validateLayout`). Asserts the six hard/physical checks
   (`noOverlaps`, `frontDoorOnExterior`, `balconiesOnExterior`,
   `frontDoorNearLiving`, `kitchenAdjacentToLiving`,
   `ensuiteBathroomsAdjacent`) are at exactly 0% failure with zero
   tolerance - these represent unbuildable geometry, not judgement calls -
   and that the overall pass rate stays at or above a 95% floor (comfortably
   below the 98.8% actually observed, so the assertion catches a real
   regression without being brittle to ordinary noise).

Run (`npm test` from `server/`, or `node --test src/ruleEngine/__tests__/batch.test.mjs`):
**3/3 tests pass.** Sweep result: **664/672 (98.8%) overall**, with
`noOverlaps`, `frontDoorOnExterior`, `frontDoorNearLiving`,
`kitchenAdjacentToLiving`, `balconiesOnExterior`, and
`ensuiteBathroomsAdjacent` all at **0/672 (0.0%) failures** - every
remaining failure is the single accepted `livingNotOversized` edge case
(open issue #1 above). This independently reproduces the fixer's
previously-reported number rather than just repeating it.

## Day 7-8 — DXF export + 2D preview

**Next milestone - builder starts here.** Rule engine core (Day 3-5) and
batch testing (Day 6) are both done and reviewed; nothing is blocking this.
Per `docs/PLAN.md`: hand-written minimal DXF export (LWPOLYLINE + TEXT per
room, `server/src/dxf/exportDxf.js`, no dependency, so it stays fully
explainable) from a `solveLayout()` result, plus a quick 2D SVG preview in
the client for fast visual iteration. `solveLayout()`'s output shape is
`{ rooms: [{id, type, cx, cy, w, h}], plot: {widthM, depthM, areaM2} }` -
see `server/src/ruleEngine/solver.js`'s return statement and
`server/src/ruleEngine/demo.js` for a working example of producing one.

Heads-up for whoever builds this: `rooms[].cx/cy/w/h` are still in the rule
engine's normalised UNIT space, NOT real metres - only `plot.widthM/depthM`
get the `metersPerUnit` conversion applied (see `solver.js` around line
630-642). `solveLayout()` computes `metersPerUnit` internally but doesn't
currently return it, so DXF/SVG code that wants real-world room coordinates
will need to either (a) have `solveLayout()` also return `metersPerUnit`
alongside `plot` (a small, low-risk addition), or (b) recompute it by
calling `estimatePlotDimensions(rooms)` from `plotSizing.js` again (safe -
it only depends on room *types*, not positions, so it reproduces the same
value). Left as-is rather than changed here since it's routine follow-on
work for the DXF milestone itself, not a rule-engine correctness bug.
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
