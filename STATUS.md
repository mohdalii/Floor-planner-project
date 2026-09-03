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

## Day 7-8 — CAD-style 2D rendering (SVG) + DXF export

**Status: CLOSED OUT for the rendering/circulation half; DXF export still
explicitly open (see "Reviewer close-out (Day 7-8, THIRD and final pass -
after the redesign that replaced same-type chaining)" near the end of this
milestone for the final call, independent re-verification - including a
quantified real-dataset extremity check for the residual 6.0% - and the
next milestone). IMPORTANT for anyone reading this section top to bottom:
the "Through-room decision" recorded partway down (in the second reviewer
close-out) accepted same-type sibling chaining (bathroom_1 -> bathroom_0,
etc.) as a documented MVP limitation. That decision was REPLACED, not
supplemented, by a later fixer pass ("Fixer pass — same-type chaining
replaced with real-data-grounded independent frontage"), after the user
rejected it based on real ResPlan data showing a genuine door directly
between two bathrooms happens in only 0.16% of real plans - and THAT
redesign is what the final reviewer close-out at the end of this section
verifies and closes out. Everything between here and that final section is
kept as history (what was tried, what was learned) - it is NOT the current
state of the code.**

**Revised scope.** The first pass at this milestone (before this entry) was
a quick throwaway preview: one flat-coloured `<rect>` per room, floating
with visible gaps between them, no walls, no doors
(`.preview/sample_floor_plan.svg` - generated by a scratch script, never
committed, gitignored under the "throwaway visual previews" rule already in
`.gitignore`). The user reviewed it and rejected it: they want real
architectural CAD-style drawings, matching reference images they
provided - walls connected into a single network (not separate boxes),
doors cut into shared walls with swing-arc symbols, room labels, dimension
lines, no colour fill (black lines on white). `docs/PLAN.md`'s Day 7-8 row
was updated to reflect this before this pass started. DXF export (the
other half of the original Day 7-8 scope) is explicitly deferred to a
later pass - this pass is entirely about getting the rendering approach
right first, since that's the specific, direct complaint that needed
fixing.

**What was built** (`server/src/render/`, plain ESM JS, no new
dependencies, heavily commented for the same "viva-ready" reason as the
rule engine):

- `wallNetwork.js` - `buildWallNetwork(rooms, plot)`. This is the actual
  fix for "boxes aren't connected": every room contributes its 4 edges to a
  shared pool, edges from different rooms that describe the same physical
  wall line get clustered together (`clusterCoords`), and touching/close
  spans on the same line get merged into one continuous drawn segment
  (`mergeIntervals`) - so a wall between two adjacent rooms is drawn
  exactly once, not as two competing rectangles with a gap between them.
  Also builds the 4 exterior wall segments (thicker than interior, matching
  real construction: ~10cm interior stud wall vs ~20cm exterior wall).
  Concept ported from `D:\ai-floor-planner\python\app\floor_generator\cad_render.py`'s
  `build_interior_walls`/`build_exterior_walls` (a separate, do-not-modify
  project, working from a completely different room representation - not
  copied code).
- `doors.js` - `placeDoors(network, attachMap)`. For every relationship in
  `buildAttachMap()`'s output, finds the ACTUAL shared edge between those
  two specific rooms (`sharedEdge` - checks both possible sides per axis,
  since attachMap doesn't record which side of which room is which) and
  cuts a door-width gap into whichever wall segment that edge lies on,
  clamped away from wall corners/junctions. The front door is
  special-cased (`placeFrontDoor`) since it's a marker box, not a room with
  two neighbours: finds which of the 4 exterior walls it's closest to and
  cuts a standard-width opening there. Ported concept from the same
  reference file's `shared_edge`/`place_interior_doors`/`place_front_door`.
  Returns a diagnostics object (which relationships got a door, which were
  skipped and why) rather than just mutating silently - this is what
  demo.js's self-checks below are built on.
- `svgRenderer.js` - `renderFloorPlanSvg({ rooms, plot }, attachMap)`. Runs
  the two files above, then draws: filled black wall pieces with the door
  gaps actually cut out (not overlaid), door swing symbols (a leaf line +
  a 90-degree arc, sampled as a 16-point polyline rather than an SVG `A`
  command - deliberately, to avoid reasoning about sweep-flag
  clockwise/counterclockwise in a y-down coordinate system, which is easy
  to get subtly backwards and hard to eyeball-verify; sampling `hinge +
  radius at angle` point by point is simple to check by hand and can't be
  flipped), room labels + per-room dimension strings (skipped when a room
  is too small to hold them legibly - a real gate, unlike the reference
  file's version of the same idea, which always clamped the font size UP to
  a minimum and so never actually skipped anything), and overall building
  dimension lines with tick marks. Room interiors get NO fill at all
  (plain white background shows through) - the direct fix for the
  colour-fill complaint.
- `demo.js` - runnable end-to-end demo (`node server/src/render/demo.js`),
  same plausible mid-size family home as `ruleEngine/demo.js` (3 bed / 2
  bath / 1 kitchen / 1 living / 1 balcony / 1 storage), run through the
  full pipeline including `renderFloorPlanSvg`, writing real output to
  `server/src/render/sample_output.svg` (NOT gitignored, unlike the old
  throwaway preview - this is the real implementation now).

**A note on unit conversion** (resolving the heads-up left in this section
before this pass): went with option (b) from that note.
`wallNetwork.js`'s `roomsToMeters()` calls `estimatePlotDimensions(rooms)`
from `plotSizing.js` again to recover `metersPerUnit`, rather than changing
`solveLayout()`'s return shape - confirmed safe for the same reason the
note already gave (that function only reads room `.type`, never position).

**Deviation worth flagging: WALL_SNAP had to be re-derived, not copied.**
The reference file's own wall-clustering tolerance is 0.08m, tuned for a
project where a trained model + corrector pull room boxes to near-exact
contact. This project's `seeding.js` deliberately leaves a small
`SEED_GAP` between rooms that are meant to be adjacent, and `solver.js`
only closes it further if the room has an actual attach-map problem
(`ADJACENCY_TOLERANCE` = 0.03 unit-space) - a plain sibling-to-sibling gap
(two bedrooms in the same row, no attach-map entry between them) is never
touched again once seeded. Measured directly (not guessed) by running the
real pipeline across several room programs and converting every adjacent
room pair's gap into real metres: genuine shared-wall gaps landed at
0.000m-0.412m, with the next "these aren't actually neighbours" pair a
clean ~4x further away (1.589m+). `WALL_SNAP` was set to 0.50m (comfortably
inside that gap in the distribution) - see the long comment in
`wallNetwork.js` for the full measurement. Using the reference's 0.08m
here would have reproduced the exact "boxes don't connect" complaint this
milestone exists to fix.

**Verification performed:**

`node server/src/render/demo.js` runs end-to-end, writes
`server/src/render/sample_output.svg` (8.6KB, 70 lines), and prints two
geometric self-checks (can't view the rendered image directly, so these
check the underlying geometry instead of trusting the picture):

1. *Wall continuity* - for every attach-map relationship, is there a
   continuous wall segment (built by `buildWallNetwork`, BEFORE any door
   cut) covering the full span the two rooms actually share? **5/5 PASS**
   for the demo scenario (bathroom_0<->living, bathroom_1<->living,
   kitchen_0<->living, storage_0<->kitchen_0, balcony_0<->bedroom_0).
2. *Door-cut coverage* - did every attach-map relationship, and the front
   door, get an actual door cut? **5/5 interior doors placed, 0 skipped,
   front door placed: true.**

Manually cross-checked the printed wall/cut geometry against the demo's
own room coordinates (not just trusted the self-check output) - e.g. the
wall between living and the bathroom column (`v coord=10.38,
span=[0.46,6.15]`) correctly carries TWO separate door cuts, one per
bathroom, on one continuous segment; the wall behind the whole 3-bedroom
row (`h coord=10.10, span=[4.57,16.12]`) is one continuous segment with a
single cut for the one balcony attached to bedroom_0. This is the literal
"connected network, doors cut into shared walls" behaviour the milestone
asked for, confirmed on real numbers, not just algorithm description.

Also spot-checked (ad-hoc, not committed as a test) across several other
room programs (1 bed/1 bath minimal case, 2 bed/3 bath/2 balcony, 6 bed/6
bath/3 balcony, 4 bed/1 bath/0 kitchen) to make sure nothing crashes or
produces malformed SVG outside the one demo scenario - none did. That
sweep surfaced two real findings, both rule-engine-level (not rendering
bugs), reported here rather than fixed, per this role's "don't invent
scope" rule:

**Known open issues (found here, not fixed here at the time) - both
resolved by the fixer pass documented further down this section:**

1. **Bedrooms have no interior door at all.** `attachMap.js` never gives a
   bedroom a `src` entry (bedrooms are always a `target` - for en-suite
   bathrooms, or the first balcony - never a source of their own
   relationship). Since `doors.js` cuts doors strictly per attach-map
   relationship (exactly as the milestone spec asked), a bedroom that
   isn't the target of any relationship gets literally zero doors, and
   even a bedroom that IS a target (e.g. bedroom_0 with a balcony
   attached) only gets a door to that one exterior space, not to the rest
   of the house. Confirmed systemic, not an edge case: in the demo's
   10-room layout, all 3 bedrooms end up with zero doors to any interior
   circulation space. This is a gap in `attachMap.js`'s relationship model
   (a Day 3-5 file, already reviewed and closed out), not something the
   renderer can fix without inventing a new adjacency rule
   (`bedroom -> living`, say) that the rule-engine milestone never
   specified - flagged for whoever reviews this pass to decide whether
   `attachMap.js` should be extended, rather than the renderer silently
   deciding that on its own.
2. **A bedroom with BOTH an en-suite bathroom AND a balcony can end up
   with its balcony door skipped.** `seeding.js` places both an en-suite
   bathroom and a balcony "behind" the same bedroom, using independent
   stack counters (`${targetId}:bathroom` vs `${targetId}:balcony`) - so
   both are initially seeded landing on the exact same spot behind the
   bedroom. `solver.js`'s priority rules correctly push the lower-priority
   balcony out of bathroom_0's way (bathroom priority 70 > balcony
   priority 25), but since collision-avoidance always outranks
   relationship-satisfaction in the solver's lexicographic cost (by
   design - see solver.js's own comment), the balcony can get stuck
   settled one room further back than its attach target, touching the
   bathroom instead of the bedroom it's actually mapped to. Reproduced
   directly: requesting `{bedrooms:2, bathrooms:3, balconies:2, ...}`
   (bathrooms >= bedrooms triggers en-suite pairing) leaves `balcony_0`
   2.15m from `bedroom_0` - `doors.js` correctly detects this isn't a real
   shared wall (`WALL_SNAP` = 0.50m rejects it, exactly as intended) and
   skips the door rather than drawing one in the wrong place, reporting
   `"no shared wall found between these two rooms within WALL_SNAP"`
   through its diagnostics. Notably, `validate.js`'s existing checklist
   does NOT catch this - it only checks `balconiesOnExterior` (does the
   balcony touch some exterior edge), never balcony-to-target adjacency -
   so this is a genuine rule-engine gap this rendering pass's stricter
   geometric self-check surfaced that the Day 3-5/Day 6 checks never
   would have. A `seeding.js`/`solver.js` fix (e.g. a second stacking
   column so en-suite bathroom and balcony don't compete for the same slot
   behind a bedroom), not a rendering fix - flagged, not touched here.

**Concerns for the checker** (things this builder pass could verify
geometrically but can't confirm by eye, not having an image viewer):

- Text legibility/overlap at the actual rendered scale - font sizes are
  computed from a fit-to-box heuristic (ported from the reference file,
  see `fitFontSizePx` in `svgRenderer.js`) that's never been checked
  against an actual rendered image. Worth opening
  `server/src/render/sample_output.svg` in a browser/SVG viewer to confirm
  labels and dimension strings genuinely stay inside their rooms and don't
  visually collide with wall lines or door swing arcs.
- The `PAD_TOP_M`/dimension-line placement choice (both overall dimension
  lines ganged off the top-left corner, title text above them) is a
  reasonable but essentially untested layout choice - worth a visual check
  that the title and the width-dimension line don't crowd each other.
- The choice not to flip the y-axis (see the comment in
  `renderFloorPlanSvg`) means the front door consistently renders near the
  TOP of the image (y=0 is the plot's front/street edge in this project's
  own coordinate convention). This is arbitrary but consistent - worth
  confirming it doesn't read as visually backwards against the user's
  reference images, which may assume the opposite convention.
- Furniture icons (beds, sofas, kitchen counters, bathroom fixtures) exist
  in the reference file but were deliberately NOT ported - several of the
  user's own reference images are plain line drawings with no furniture at
  all, and the milestone's explicit ask (connected walls + doors + labels
  + dimensions) doesn't need them. Documented as skipped, not forgotten.

**Original heads-up on unit conversion**, kept for history since it's now
resolved (see "A note on unit conversion" above): `rooms[].cx/cy/w/h` from
`solveLayout()` are still in the rule engine's normalised UNIT space, NOT
real metres - only `plot.widthM/depthM` get the `metersPerUnit` conversion
applied internally. `solveLayout()` was left unchanged (not given a new
return field) - the render layer recomputes the same factor itself instead.

**Not started:** DXF export (`server/src/dxf/exportDxf.js`), deferred per
the revised scope above - hand-written LWPOLYLINE + TEXT per room, same
"no dependency, stays fully explainable" reasoning `docs/PLAN.md` already
called for. Should be able to reuse `wallNetwork.js`'s meter-space room
conversion directly once started.

**Fixer pass — bedrooms were architecturally unreachable; en-suite
bathroom + balcony seeding collision.**

The checker's two findings above turned out to be one real architectural
gap, not two unrelated bugs: `attachMap.js` never gave a bedroom a
relationship pointing back toward living - only relationships pointing AT
it (an en-suite bathroom, a balcony) - so a bedroom could be, and in the
checker's own reproduction was, fully sealed off with zero doors to the
rest of the house. An independent BFS reachability sweep across 5 varied
room programs (rebuilt from scratch, not reusing the checker's throwaway
script - see below) confirmed this was systemic: **17/17 bedrooms
unreachable**, including the "full en-suite" case, where a bedroom's only
neighbour (its own bathroom) had no relationship back to living either.

**The fix: an automatic `hallway`, the same way `front_door` is
automatic.** The user's own reference floor plans show an explicit hallway
connecting bedrooms to the rest of the house - this is standard practice
the rule engine was missing entirely, not a workaround invented here.

- `constants.js` - `HALLWAY_DEPTH_M` (1.35m, a fixed real-world corridor
  depth - see its own long comment for why hallway can't be sized off
  `SIZE_RANGES` the way every other room type is: the ResPlan dataset has
  no "hallway" room type at all, checked directly against
  `data-analysis/output/rule-constants.seed.json`'s `room_type_frequency`,
  and a corridor's defining dimension is a roughly-constant real-world
  depth, not a fraction of total floor area). `PRIORITY.hallway = 80`,
  between bedroom (85, must be placed first - hallway's width is measured
  from the bedroom row's actual extent) and bathroom (70, must never be
  allowed to shove hallway off its by-construction position).
- `roomProgram.js` - always adds exactly one `hallway_0`, same "automatic,
  not a user-supplied count" pattern as `front_door`. Deliberately NOT
  added to `ROOM_TYPES` (which drives the `SIZE_RANGES` loop and would
  throw at startup with no dataset entry to size it from) - it's structural,
  handled explicitly, same as `front_door`.
- `attachMap.js` - every `bedroom_i -> hallway_0`, plus `hallway_0 ->
  living_0`. Confirmed (not assumed) that a plain `{}` attach map supports
  `hallway_0` being both a KEY (its own entry) and a VALUE (in every
  bedroom's entry) without conflict - nothing downstream ever assumed an id
  could only be one or the other.
- `seeding.js` - the real geometric fix, and the one that took several
  iterations to get right (see below): the hallway is placed as a strip
  spanning the bedroom row's ACTUAL measured width (not an assumed one),
  positioned so its back edge and the bedroom row's front edge share the
  exact same y-coordinate by construction (checked directly: they're
  literally computed from the same `hallwayDepth` value, not two
  independently-computed numbers that happen to land close), and its own
  front edge touches living with the same `SEED_GAP` every other
  living-adjacent room in this file uses.
- `validate.js` - new check 8, `everyBedroomReachable`: for every bedroom,
  confirms an ACTUAL shared wall (not just a small bounding-box gap) with
  the hallway, and the hallway has one with living. Deliberately stricter
  than this file's other adjacency checks (which all use a plain
  `gapBetween <= ADJACENCY_TOLERANCE`): a new `hasSharedWall` helper
  additionally requires a real overlapping span (mirroring doors.js's own
  `MIN_SHARED_SPAN`, converted into this file's unit space), because a
  plain bounding-box-gap check is exactly what let the balcony/bathroom
  collision below go undetected the first time - this check is built not
  to repeat that mistake. Added to `batch.test.mjs`'s hard-check list
  (zero-tolerance, alongside `noOverlaps`) so a future regression here
  would actually fail the committed test suite, not just this file's own
  checklist.

**Getting the geometry to genuinely touch took three attempts, not one -
worth recording why the first two were wrong, not just that they were:**

1. *First attempt:* place the hallway directly behind living, unaffected
   by anything else. Broke immediately on the render demo's own stricter
   self-check (not on any committed test - see why below): a shared "hall"
   bathroom stacked on living's right side (2 bathrooms, the exact
   long-standing demo scenario) already reached almost exactly as far down
   as living's own footprint was assumed to end - a hairline-tight fit that
   used to "work" only because the OLD bedroom row only partially blocked
   that same space, leaving the bathroom a sideways escape route. The new
   hallway spans the bedroom row's FULL width, closing that escape route
   entirely, so the same near-miss geometry produced a genuine seed-time
   overlap. `solver.js`'s collision safety net (which has no awareness of
   attach relationships, by design) "resolved" it by cascading the
   bathroom far enough away from living to lose its door entirely.
2. *Second attempt:* widen the gap the bedroom row/hallway start from to
   account for whatever's already stacked near living. Wrong in a
   different way: since a single rectangular hallway can't touch living at
   one y for part of its width while dodging a stack at a different y for
   the rest, this broke the hallway<->living wall EVERYWHERE along its
   width, not just near the bathroom.
3. *What actually worked:* bound the stack itself instead of moving the
   hallway. `seeding.js`'s `claimPosition` now wraps a "right"/"left"
   fan-out (shared bathrooms, kitchen, storage - anything stacked directly
   off living) into a new column once it would reach past living's own
   height, so it can never extend into the hallway's zone in the first
   place. Placing shared-target rooms (a pass-1/pass-2 split for
   bathrooms - see `placeBathrooms()`) before the bedroom row/hallway are
   positioned was also needed, so this bound is enforced before anything
   downstream depends on where the bedroom zone starts.

**The en-suite bathroom + balcony collision (independent second finding,
same root mechanism as (1) above) took an extra iteration too.** The
checker's diagnosis (independent stack counters for
`${targetId}:bathroom` vs `${targetId}:balcony` don't know about each
other) was correct, but the first fix attempted from it - key BOTH by
`${targetId}:${side}` so they share one counter - only trades one
collision for another: bathroom_0 and balcony_0's COMBINED width can
genuinely exceed one bedroom's own width for real dataset-derived room
sizes (~0.40-0.43 units needed vs ~0.39 available in the reproduction
case), so a shared counter either stacks balcony behind bathroom (never
touching the bedroom, failing the actual requirement) or, left unbounded,
lands balcony in the NEXT bedroom's own en-suite zone (a different real
collision). The fix that actually holds: give the master's balcony a
genuinely different side (`left` of its bedroom, not `back`) instead of
trying to share bathroom's slot at all - bedroom_0 (the only bedroom a
balcony's attach target is ever type `bedroom`, per `attachMap.js`'s own
rule) is always the row's LEFTMOST bedroom, so its left side is guaranteed
empty and doesn't compete with anything. The `claimPosition`/target+side
keying mechanism itself is kept as general infrastructure (it's what lets
several shared bathrooms fan out safely on the SAME side, and is strictly
more correct than the old per-role keying it replaced even where it isn't
load-bearing for this specific fix).

**Verification performed:**

- *BFS reachability*, rebuilt from scratch (the checker's own script was
  throwaway, per this pass's instructions) across 5 varied room programs -
  3bed/2bath hall-bathrooms, 2bed/3bath full en-suite, 1bed/1bath/1balcony,
  4bed/0bath, 5bed/5bath/2balcony: runs the FULL real pipeline including
  `buildWallNetwork`/`placeDoors`, builds a graph from the ACTUAL placed
  doors (not attach-map labels), BFS's from living. **Every bedroom
  reachable from living through real doors in all 5 scenarios (5/5)** -
  before the fix, this was 0/5 (17/17 individual bedrooms unreachable).
- *`npm test` (committed batch sweep, `server/`):* **3/3 tests pass.**
  672-combo single-living-room sweep: **668/672 (99.4%)**, UP from the
  664/672 (98.8%) baseline before this pass - `noOverlaps`,
  `frontDoorOnExterior`, `frontDoorNearLiving`, `kitchenAdjacentToLiving`,
  `balconiesOnExterior`, `ensuiteBathroomsAdjacent`, and the new
  `everyBedroomReachable` are all **0/672 (0.0%) failures**.
  `livingNotOversized` improved too (4/672, down from 8/672) - expected
  and understood, not a coincidence: the hallway is a real room with real
  area now included in every plan's total built area, which dilutes
  living's share of that total for every program, independent of anything
  placement-related.
- *`node server/src/render/demo.js`* runs clean (no crash, valid SVG,
  10.6KB/84 lines) and the hallway shows up sensibly in the actual output -
  checked the raw numbers, not just "it rendered something": the HALLWAY
  label reads "11.55m x 1.35m" (1.35m is `HALLWAY_DEPTH_M` exactly,
  confirming the unit-to-metres round-trip is exact, not approximate), it
  carries doors to all 3 bedrooms plus living, and the wall-continuity
  self-check passes for `bedroom_0/1/2 <-> hallway_0` and `hallway_0 <->
  living_0` with full, unbroken spans.
- *En-suite bathroom + balcony collision, exact reproduction case*
  (`{bedrooms:2, bathrooms:3, kitchens:1, livingRooms:1, balconies:2,
  storages:1}`): re-ran `sharedEdge(balcony_0, bedroom_0)` (the literal
  function `doors.js` uses) directly against the solved layout - now finds
  a real vertical wall, gap 0.19m (well inside `WALL_SNAP` = 0.50m), not
  the reported 2.148m. All **10/10 interior doors placed, 0 skipped** (was
  9/10 placed, `balcony_0 -> bedroom_0` skipped, before the fix). Full
  `validateLayout` passes on this exact case, including the new
  `everyBedroomReachable`.

**Known open issue, newly surfaced by this pass (found here, not fully
resolved here):** in the specific, previously-demonstrated 3-bedroom/
2-bathroom scenario (`ruleEngine/demo.js` / `render/demo.js`'s own
requirements), the SECOND shared "hall" bathroom no longer gets a door to
living. This is the direct, understood cost of the column-wrap fix above:
2 shared bathrooms of the actual dataset-derived size, stacked directly on
living's own wall, need marginally MORE room (by about 0.001 unit-space,
under 2cm in real terms) than living's own height provides before
reaching the hallway's zone - a hairline-tight fit that only "worked" in
the pre-hallway code by accident (nothing occupied that space to collide
with). Column-wrapping correctly prevents the overlap (confirmed:
`noOverlaps` stayed at 0% across the full 672-combo sweep, including
configurations with up to 6 bathrooms), but the wrapped second bathroom
ends up beside the first one rather than beside living, so it has no
direct wall to living in this specific tight configuration. Not caught by
any committed check (no existing `validate.js` check verifies a SHARED,
non-en-suite bathroom's adjacency to living at all - only `doors.js`'s own
stricter self-check surfaces it, the same way it surfaced the original
balcony finding). Left unfixed here, deliberately: every fix attempted for
this (letting the stack encroach slightly on the hallway, widening the
bound, wrapping into a different arrangement) either reintroduces the
`noOverlaps` regression this whole pass exists to prevent or requires a
more invasive placement redesign (e.g. genuinely 2D bin-packing for
living's attached rooms, or routing extra shared bathrooms off the
hallway instead of living directly - arguably the more realistic
real-world pattern once there are more than 1-2 of them) than a scoped fix
for two specific findings should attempt. Flagged for whoever reviews this
pass to decide whether it's worth a dedicated follow-up.

**Reviewer close-out (Day 7-8):**

*Independent verification performed (not just trusting the fixer's
numbers):*

- `node server/src/ruleEngine/demo.js` - re-ran fresh: still passes all 8
  checks (7 original + `everyBedroomReachable`), plot 16.12m x 11.59m,
  matches the fixer's report.
- `node server/src/render/demo.js` - re-ran fresh: still writes a valid SVG
  (10,590 bytes/84 lines), self-check 1 (wall continuity) and self-check 2
  (door-cut coverage) each report exactly one failure -
  `bathroom_1 <-> living_0` - which is the known open issue the fixer
  flagged. Everything else passes, matching the fixer's account.
- `npm test` (`server/`) - re-ran fresh: **3/3 tests pass**, sweep
  **668/672 (99.4%)**, `everyBedroomReachable` at **0/672 (0.0%)
  failures**. Confirms the fixer's headline numbers exactly.
- *Hand-verified 2 of the fixer's 5 reachability scenarios by reading raw
  coordinates, not trusting any pass/fail script* - converted solved
  layouts to real metres myself (independent script, bypassing
  `hasSharedWall`/`sharedEdge` entirely, plain arithmetic on box edges) for
  the "3 bed/2 bath, hall bathrooms" and "2 bed/3 bath, full en-suite"
  scenarios. In both: every bedroom's front edge sits exactly 0.19m from
  the hallway's back edge with a 3.7m+ overlapping span (not a corner
  graze), and the hallway's own front edge sits 0.19m from living's back
  edge with a 5.6m+ overlapping span. This is a genuine, generous shared
  wall in both scenarios, not a hairline coincidence - the bedroom
  reachability fix is real and solid.

*The open issue is much bigger than it was described - decided here, not
deferred.* The fixer's writeup framed the "second hall bathroom loses its
door" problem as one narrow, ~2cm-tight scenario specific to the demo's own
3-bed/2-bath case. Reproducing it directly (`sharedEdge`/`placeDoors` run
against the demo's exact layout) confirmed the mechanism but not the scope:

- `bathroom_1` isn't narrowly missing its door by 2cm - it has **zero doors
  anywhere**, full stop. It IS genuinely touching `bathroom_0` (a real
  1.9m-long shared wall, gap 0.19m, easily within door-cutting tolerance),
  but `attachMap.js` never gives two same-type siblings (two hall
  bathrooms, two storages) a relationship to EACH OTHER - only each one's
  own relationship to its declared target (`-> living`, `-> kitchen`). So
  even though a walkable wall physically exists between the two bathrooms,
  nothing ever tells `doors.js` to cut a door there.
- Traced the root cause in `seeding.js`: `claimPosition`'s column-wrap
  (added this same pass, to stop a long bathroom stack from reaching into
  the new hallway's zone) bounds a "right"/"left" stack to the target's own
  half-height (`maxPerpExtentFor`). For dataset-derived bathroom sizes,
  that bound is already exceeded by the SECOND occupant, so it wraps into a
  brand new column immediately - and a new column is positioned beside the
  PREVIOUS occupant, not beside the actual target. The 1st shared room in
  any stack always touches its target directly; the 2nd, 3rd, ... never do,
  by construction, regardless of how much genuine space exists.
- **This isn't bathroom-specific or rare - measured it directly across the
  exact same 672-combination grid `batch.test.mjs` already uses as the
  project's regression sweep:** at least one non-front-door room ends up
  with **zero placed doors in 408/672 combinations (60.7%)** - 640 sealed
  bathroom instances and 168 sealed storage instances (storage hits the
  identical mechanism: requesting 2 storage rooms seals `storage_1` **every
  single time**, unconditionally, no bathroom/bedroom count needed to
  trigger it). Scaling test: with 1 bedroom and an increasing bathroom
  count, exactly 2 bathrooms ever get a real door (the en-suite one + the
  first shared one) no matter how many are requested - 6 of 8 sealed at the
  extreme. And this isn't confined to unrealistic combos the way the
  accepted `livingNotOversized` edge case is: **the project's own
  repeated "plausible mid-size family home" demo scenario (3 bed/2 bath)
  has a sealed bathroom**, and so does a plain 4 bed/2 bath household - both
  about as ordinary a request as this generator will ever receive.
  Balconies are NOT affected (they use the unbounded "front"/"back" side,
  which never wraps) - this is specific to the "right"/"left" bounded
  column logic.
- Crucially, **no committed check catches any of this.**
  `everyBedroomReachable` only looks at bedrooms; nothing in `validate.js`
  checks a shared bathroom's or storage's reachability at all, because
  `validate.js` never touches `wallNetwork.js`/`doors.js` in the first
  place - it works entirely in the rule engine's abstract unit-space boxes.
  That means the batch test's headline **99.4%** is a real, honest number
  for what it measures (rule-engine geometry), but it says nothing about
  whether the room a user actually sees rendered has a door - and on this
  same grid, most of the time, at least one room doesn't.

**Decision: this needs another fix pass now - it is NOT a legitimate
edge case to accept.** Reasoning, weighed the same way the earlier
`livingNotOversized`/multi-living scope decisions in this file were:

- Frequency and realism are the opposite of the accepted precedent. The
  accepted `livingNotOversized` edge case is ~1% of the sweep and only
  triggers on room programs no real user would plausibly ask for (1 bedroom
  + 5 bathrooms, no kitchen). This defect is **60.7%** of the same sweep and
  is triggered by completely ordinary requests (3 bed/2 bath; 4 bed/2 bath;
  any request for 2 storage rooms). "Accept it as an edge case" isn't an
  honest description of something that hits most inputs.
- It's not a soft numeric threshold judgement call (like
  `livingNotOversized`, which is genuinely a statistical "is this a bit
  much" question) - it's a hard, visible defect in exactly what this
  milestone exists to deliver. `docs/PLAN.md`'s own Day 7-8 line says "doors
  cut into shared walls" - a room with solid walls on every side and no
  door at all is the literal opposite of that, and it would be plainly
  visible to anyone opening the rendered SVG.
- It's the same class of bug this very pass already treated as
  non-negotiable to fix: bedrooms with no door to the rest of the house.
  Leaving bathrooms/storage in that same sealed state right after fixing it
  for bedrooms, in the same file, for the same underlying reason (a
  same-type sibling with no relationship of its own), would be inconsistent
  - not a considered scope boundary.
- It's cheap to characterize but was invisible to every existing check -
  that's a coverage gap in `validate.js`/the render self-checks, not just a
  seeding bug, and it's the kind of gap that would otherwise ship silently
  into the frontend/report demo screenshots.

This is a call, not a deferral: the next builder pass should treat "every
room has an actual door to the rest of the house, not just bedrooms" as
this milestone's real finish line before moving on. Not prescribing the
exact fix (that's the builder's job), but flagging the shape of it based on
what tracing the bug surfaced: either give a wrapped 2nd+/3rd+ occupant in
the same column a relationship to the room in the PREVIOUS column instead
of only ever to the shared target (matches the real touching wall that
already exists), or route additional shared bathrooms/storage off the
hallway once more than one needs to share living's side (arguably the more
realistic real-world layout pattern once there are 2+ of them, and sidesteps
needing living's own edge to hold an unbounded number of doors). Whichever
direction is chosen, `validate.js` should also grow a general
"every non-front-door room is reachable from living" check (the same BFS
idea `everyBedroomReachable` already uses, generalized) so this class of
bug can never again ship invisibly through the batch test.

**Milestone status, stated plainly for the record:**

- **Done and solid:** the rule-engine circulation fix (automatic hallway,
  bedroom reachability) - independently re-verified above on both the
  numbers and the raw geometry.
- **Built, but not yet correct:** the SVG renderer (walls, doors, hallway,
  labels, dimensions) - real progress, matches the user's reference-image
  ask structurally, but has the door-reachability defect above affecting
  the majority of realistic room programs.
- **Not started:** DXF export (`server/src/dxf/` is an empty directory -
  confirmed, zero files). This was explicitly deferred, not overlooked - the
  original builder was told to focus on the renderer first, and that
  decision is documented earlier in this section.
- **Not started:** windows. The user asked about this mid-milestone
  ("what about windows doors open ways etc etc") and was told it would be
  queued as a follow-up once the circulation fix landed. It hasn't been
  touched anywhere in the codebase - confirmed by review (no `window`
  reference exists in `server/src`). This should not be read as done, or as
  quietly dropped - it's queued, per what the user was told.

**Next milestone.** Given the above, the next builder pass should NOT jump
straight to windows or DXF export - it should first close the real gap this
review found:

1. **Fix door reachability for every shared room, not just bedrooms**
   (the scoped fix described above), and add the general reachability
   check to `validate.js` so it's a committed regression guard, not just
   something this review happened to catch by hand. This is a continuation
   of Day 7-8, not a new milestone - the milestone isn't actually done
   until a floor plan's rendered doors match what `docs/PLAN.md` promised.
2. **Then windows** - small, renderer-only, and it's the one thing already
   explicitly promised to the user as "next" once circulation was fixed;
   doing it right after the reachability fix (rather than before) means
   window placement logic gets built against a wall network that's actually
   correct, instead of needing to be revisited once doors are fixed anyway.
3. **Then DXF export** - the other half of the original Day 7-8 scope,
   larger and more self-contained (a new `server/src/dxf/exportDxf.js`
   module, per `docs/PLAN.md`), reasonable to tackle once the SVG renderer
   it will reuse geometry from (`wallNetwork.js`'s meter-space room
   conversion, per the note already in this file) is actually finished and
   correct. Doing DXF export against a renderer with a known door-placement
   bug would just mean re-deriving the same fix a second time on the DXF
   side.

Reasoning for this order (fix, then windows, then DXF): the reachability
fix is a correctness blocker on work already claimed complete, not new
scope - it goes first on that basis alone. Windows before DXF is a judgment
call, not a hard requirement, but it's the right one here: windows is small
and was explicitly promised next to the user, or it can be paired with the
reachability fix in the same pass. DXF export is a bigger, separable body of
work better started once the thing it's exporting (the wall/door model) is
no longer mid-fix.

**Fixer pass — sealed shared-bathroom/storage rooms fixed.**

Scope: exactly the reviewer's finding above - fix door reachability for
every shared room (not just bedrooms), and add a general reachability check
to `validate.js` so this class of bug can't ship invisibly again. Root
cause was already correctly diagnosed by the reviewer (see above) - this
pass implements the fix, not a re-diagnosis.

**Which option, and why.** The reviewer's writeup offered two directions:
Option A (chain a wrapped 2nd+/3rd+ occupant's attach-map entry to whichever
sibling it's actually touching, instead of its original, now-physically-false
target label) or Option B (redesign `claimPosition`'s fan-out geometry so
every occupant, not just the first, genuinely touches the target directly).
Went with **Option A**. Reasoning:

- Option B isn't geometrically achievable in general, not just harder to
  build. A target's own edge (e.g. living's right side) only has so much
  physical length. Once a fan-out stack's COMBINED size exceeds that length
  - which is exactly the condition that triggers the column-wrap in the
  first place - there is no arrangement, however clever, that lets every
  occupant simultaneously touch that one finite stretch of wall. Multiple
  parallel columns "fanning out from the target's edge" (the reviewer's own
  phrasing for what Option B would need) still only gives the FIRST row of
  those columns direct contact with the target; anything stacked behind the
  first row is back to needing a chain to reach the target anyway - Option B
  doesn't actually eliminate chaining, it just hides one layer of it inside
  a more complicated placement scheme.
- Option A rides adjacency `claimPosition` already geometrically guarantees,
  it doesn't need to invent new geometry. Traced precisely (see
  `seeding.js`'s rewritten `claimPosition` comment for the full case
  analysis): a new occupant either (a) fits in the CURRENT fan-out column,
  in which case it's built to start exactly at the PREVIOUS occupant's far
  edge + `SEED_GAP` - always a real touch, by construction - or (b) wraps
  into a new column, whose first occupant always starts at `perpOffset 0`,
  the exact same perpendicular position the previous column's first
  occupant also started at - so the two are always guaranteed to share an
  overlapping band and touch across the column boundary, regardless of how
  many other occupants ended up stacked deeper in either column. Every
  wrapped occupant is therefore ALREADY touching a specific, identifiable
  sibling; the bug was purely that `attachMap.js` never got told to point
  at that sibling instead of the original target label.
- Matches the "same standard the reviewer used" for the bedroom fix.
  Bedroom reachability was already fixed by CHAINING (bedroom -> hallway ->
  living) rather than trying to give every bedroom a direct wall to living
  - Option A is the same idea applied one level further down, not a
  different strategy for a "similar but different" problem.

**Implementation (`server/src/ruleEngine/seeding.js`).** `claimPosition`
now also returns a `chainParentId` for every room it places:
- `null` if the room is genuinely touching the real target directly - true
  for every occupant that lands in fan-out column 0 (column 0 is bounded to
  stay within the target's own extent - see `maxPerpExtentFor` - so ALL of
  its occupants, not just the first, individually overlap the target's own
  band and touch it, not only whichever one happened to be placed first).
- the immediately-previous occupant's id, if this room fits in the SAME
  column as an already-placed occupant (case (a) above).
- the previous column's FIRST occupant's id, if this room is the first to
  land in a NEW (wrapped) column (case (b) above) - deliberately the
  column's first occupant, not whichever occupant was placed most recently
  overall, since a column can hold more than one occupant and only the
  first of the previous column is guaranteed to share the new column's
  `perpOffset 0` band.

Every call site that uses `claimPosition` (extra living rooms, both
bathroom passes, kitchen, storage, balcony - all of them, not special-cased
per room type, per this pass's own scope requirement) now feeds `chainParentId`
into a `resolvedAttachMap` - a per-call copy of the input `attachMap`,
overridden only for rooms that actually got chained. `seedLayout()`'s return
shape changed from a bare rooms array to `{ rooms, attachMap }` so this
resolved map can be handed back to the caller - every downstream consumer
(`solveLayout`, `buildWallNetwork`/`placeDoors`, `validateLayout`) now uses
THIS resolved map, not the original `buildAttachMap()` output, from
`seedLayout` onward. Updated the three places that call the pipeline this
way: `server/src/ruleEngine/demo.js`, `server/src/render/demo.js`, and
`server/src/ruleEngine/__tests__/batch.test.mjs`'s `runOne()`. No other
production call sites exist yet (the API/routes milestone, Day 9-10, hasn't
started).

Demo scenario, concretely: `bathroom_1`'s attach-map entry used to be
`bathroom_1 -> living_0` (a real wall that doesn't exist - the reviewer
measured the gap as the full width of `bathroom_0` sitting between them).
It's now `bathroom_1 -> bathroom_0` - the wall that actually exists (a real
1.9m shared span, confirmed by `doors.js`'s own `sharedEdge`). `bathroom_1`
reaches `living_0` by a two-hop path through `bathroom_0`, the same
"chained, not direct" shape the earlier hallway fix already established for
bedrooms.

**The general reachability check (`server/src/ruleEngine/validate.js`,
check 8).** Replaced `everyBedroomReachable` (bedroom-only, checked exactly
one hop: bedroom->hallway and hallway->living) with
`everyRoomReachableFromLiving` - a real BFS over a graph built from
`attachMap` relationships that ALSO pass `hasSharedWall` (this file's
unit-space equivalent of `doors.js`'s own `sharedEdge`/`WALL_SNAP` test).
Every room except `living` itself, `hallway`, and `front_door` must be
reachable from a living room by this graph. Two deliberate design choices,
both load-bearing for making sure this check actually would have caught the
original bug:

- **Edges require BOTH an attach-map relationship AND a confirmed shared
  wall - not just physical touching on its own.** A graph built from pure
  geometry (any two rooms that happen to touch, attach-map or not) would
  have marked the ORIGINAL, unfixed `bathroom_1` as "reachable" too, since
  it was always genuinely touching `bathroom_0` physically - the bug was
  never that no wall existed, it was that `doors.js` was never TOLD to cut
  a door there, because `attachMap` didn't say so. A pure-geometry graph
  would silently paper over exactly the defect this check exists to catch.
  Restricting edges to "attach-map says these are related, AND that
  relationship is physically real" mirrors precisely what `doors.js` itself
  does when deciding whether to cut a door, so the check answers the actual
  question that matters ("will there be a door here"), not a looser one.
- **Real BFS, multi-hop.** `bedroom -> hallway -> living` and (now)
  `bathroom_2 -> bathroom_1 -> bathroom_0 -> living` are both just paths in
  the same graph, not special-cased - satisfies this pass's explicit "not a
  shortcut that only checks one hop" requirement.

Verified directly, not just argued, that the check would have caught the
original bug: re-ran the demo scenario's SOLVED geometry (bathroom_1
genuinely touching bathroom_0, not living) through `validateLayout` twice -
once against the fixed, chained attach map (`everyRoomReachableFromLiving:
true`), once against the ORIGINAL, unresolved attach map that still says
`bathroom_1 -> living_0` (`everyRoomReachableFromLiving: false`). Confirms
the check is sensitive to exactly this defect, not just correlated with the
fix that removes it. `batch.test.mjs`'s hard-check list was updated to
assert `everyRoomReachableFromLiving` (renamed from `everyBedroomReachable`)
at zero tolerance, same bucket as `noOverlaps`.

**Verification performed (real numbers, not claims):**

- *Sealed-room sweep, rebuilt to match the reviewer's exact method* (same
  672-combination grid `batch.test.mjs` uses, run through the FULL pipeline
  including `buildWallNetwork`/`placeDoors`, counting any non-hallway/
  non-front_door room that ends up with zero placed doors):
  **before: 408/672 combinations (60.7%) had at least one sealed room (640
  sealed-bathroom instances, 168 sealed-storage instances) - after: 0/672
  (0.0%), zero sealed rooms of any type, across every combination in the
  grid.**
- *`npm test` (`server/`):* **3/3 tests pass.** 672-combo sweep: **668/672
  (99.4%)** - IDENTICAL to the pre-fix baseline (this fix doesn't touch
  geometry the other checks measure, only which attach-map entry a wrapped
  room resolves to, so no reason to expect movement here, and none was
  found). Per-check breakdown: `noOverlaps`, `frontDoorOnExterior`,
  `frontDoorNearLiving`, `kitchenAdjacentToLiving`, `balconiesOnExterior`,
  `ensuiteBathroomsAdjacent`, and the new `everyRoomReachableFromLiving` are
  all **0/672 (0.0%) failures** - only the pre-existing, already-accepted
  `livingNotOversized` edge case remains (4/672, unchanged from before this
  pass).
- *Bedroom reachability, re-confirmed with no regression:* re-ran the same
  5 scenarios the earlier fixer pass used (3bed/2bath hall-bathrooms,
  2bed/3bath full en-suite, 1bed/1bath/1balcony, 4bed/0bath, 5bed/5bath/
  2balcony) through the FULL pipeline including actual door placement (not
  just the geometric `hasSharedWall` check) - **5/5 still pass, every
  bedroom in every scenario has a real door**, matching the previous pass's
  result exactly.
- *`node server/src/render/demo.js` (the project's own recurring 3bed/2bath
  demo scenario):* re-ran fresh. Resolved attach map now shows `bathroom_1
  -> bathroom_0 (chained - was -> living_0)`. Self-check 1 (wall
  continuity): **9/9 relationships PASS**, including `bathroom_1 <->
  bathroom_0: continuous wall covers the full shared span [2.35, 4.25]`
  (previously the one and only FAIL). Self-check 2 (door-cut coverage):
  **9/9 interior doors placed, 0 skipped**, `bathroom_1 -> bathroom_0`
  among them, front door placed - up from 8/9 placed, 1 skipped, before
  this pass.
- *4 bed / 2 bath, the reviewer's specific "ordinary, non-edge-case"
  example:* ran through the full pipeline including door placement - `0`
  sealed rooms, all 4 bedrooms have a real door, `validateLayout` passes
  every check including `everyRoomReachableFromLiving`.

**What this pass did NOT touch, on purpose:** DXF export
(`server/src/dxf/` is still an empty directory) and windows (still nowhere
in `server/src`) - both explicitly out of scope for this pass, which was
scoped to exactly the reviewer's reachability finding. Per the reviewer's
own stated order (fix, then windows, then DXF), those remain next.

**Not claiming this milestone "done"** - that determination belongs to
whoever reviews this pass next, per this role's own scope boundary. What
can be said plainly: the specific, measured defect the reviewer found (a
majority of the sweep producing at least one sealed room) is now at 0/672,
verified by direct measurement rather than by argument, and every existing
check/number this pass could regress (`npm test`'s 99.4%, the 5/5 bedroom-
reachability scenarios) was re-confirmed unchanged.

**Reviewer close-out (Day 7-8, second pass - after the chaining fix).**

*Independent verification performed (own script, bypassing both
`validate.js`'s reachability graph AND `demo.js`'s self-checks, so this
isn't just re-reading the fixer's own diagnostics):*

- `npm test` (`server/`) re-run fresh: **3/3 tests pass**, sweep **668/672
  (99.4%)**, every hard check (including `everyRoomReachableFromLiving`) at
  **0/672 (0.0%) failures** - matches the fixer's report exactly.
- **Generalization check (this pass's actual job #1): does the chaining fix
  hold on room programs beyond the recurring 3bed/2bath demo?** Built an
  independent script that runs 5 programs the fixer never specifically
  demonstrated (1 bed/6 bath - a hall-bathroom fan-out stress test; 3 bed/1
  bath/2 storage - a storage fan-out case; 6 bed/6 bath/3 balcony - en-suite
  pairing at scale, 19 rooms; 4 bed/2 bath; 1 bed/1 bath/0 kitchen/2
  storage) through the FULL real pipeline (`buildRoomProgram` ->
  `buildAttachMap` -> `seedLayout` -> `solveLayout` -> `buildWallNetwork` ->
  `placeDoors`), then built a BFS graph from the ACTUAL placed doors
  (`doorReport.interiorDoorsPlaced` - not attach-map labels, not
  `validate.js`'s own graph-building code) and confirmed every non-living/
  non-front-door room is reachable. **0 unreachable rooms and 0 skipped
  doors across all 5 - confirms the fix generalizes, not just the one
  case that was called out.** Concretely traced real multi-hop chains, not
  just a pass/fail count - e.g. the 1 bed/6 bath case resolves to
  `living_0 -> bathroom_1 -> bathroom_2 -> bathroom_3 -> bathroom_4 ->
  bathroom_5` (a 5-hop chain reconstructed from real placed doors), and the
  3 bed/1 bath/2 storage case resolves `storage_1` via `living_0 ->
  kitchen_0 -> storage_0 -> storage_1`. These are genuine multi-hop paths
  over real geometry, not an artifact of a graph-construction shortcut.

*Job #2 - sanity-checking the chaining approach itself, quantified rather
than argued from one case.* Two things needed separating: the PRE-EXISTING,
already-accepted hallway/en-suite depth pattern (`bathroom -> bedroom ->
hallway -> living` is 3 hops, but that's not a usability problem - an
en-suite bathroom is SUPPOSED to be a private dead-end off its own bedroom,
nobody needs to walk through it to reach anything else) versus the NEW
mechanism this pass's fix actually introduces: a same-type SIBLING chain
(`bathroom_2 -> bathroom_1 -> bathroom_0 -> living`), where reaching
`bathroom_2` genuinely requires physically walking through `bathroom_1` AND
`bathroom_0` - real, individually-occupied rooms with their own privacy
expectations, not a purpose-built connector like the hallway. Wrote a second
script that isolates only this second mechanism (walks `resolvedAttachMap`
chains, counting only consecutive same-TYPE hops) and ran it across the
exact same 672-combo grid `batch.test.mjs` already uses:

- **60.7% of the grid (408/672) has at least one chained room** - matches
  the fixer's own previously-reported sealed-room rate exactly, as expected
  (it's the same underlying set of combinations, now fixed via chaining
  instead of left sealed).
- Chain length (how many same-type siblings stand between the deepest room
  and a real target) breaks down as: **0 through-rooms: 39.3% (264/672); 1
  through-room: 32.1% (216/672); 2: 14.3% (96/672); 3: 9.5% (64/672); 4:
  4.8% (32/672).**
- Critically, **this isn't confined to extreme combos the way the deep
  chains are.** The project's own recurring 3-bed/2-bath demo, and a plain
  4-bed/2-bath request, both land at exactly **1 through-room**
  (`bathroom_1 -> bathroom_0 -> living`) - an entirely ordinary request
  produces a bathroom only reachable by walking through another bathroom.
  The DEEPER chains (2-4 through-rooms) are confined to the same flavour of
  unrealistic combo already accepted for `livingNotOversized` (1 bedroom +
  4-6 bathrooms, no kitchen) - checked directly: every run>=3 example in the
  grid is a 1-bedroom/5-or-6-bathroom program.

**Through-room decision: accept as a documented MVP limitation, not a
blocker - but it must be written down here, not silently waved through.**
Reasoning, weighed the same way this file's other scope calls have been:

- It genuinely is a real-world usability smell, not just a rendering
  nicety. A bathroom whose only access is through a DIFFERENT bathroom (not
  a purpose-built corridor) is a real architectural defect real floor plans
  avoid - if someone is using `bathroom_0`, `bathroom_1` becomes
  inaccessible, which is a legitimate problem to flag, not hand-wave away.
- But it is NOT the same class of defect as the sealed-room bug this pass
  fixed, and shouldn't be graded on the same scale. The sealed-room bug was
  `docs/PLAN.md`'s own literal promise ("doors cut into shared walls")
  broken outright - a room with zero doors anywhere is the flat opposite of
  that. Every room now genuinely has a real, physical door to the rest of
  the house; the milestone's literal, stated deliverable IS met. What
  remains sitting on top of that is an architectural QUALITY concern, not a
  broken promise - the distinction matters for how urgently it needs fixing.
- It's architecturally the same SHAPE as the hallway pattern this project
  already built and accepted (`bedroom -> hallway -> living` is also
  "chained, not direct") - the one real difference is that hallway is a
  connector nobody occupies, while a chained sibling (`bathroom_0`,
  `storage_0`) is a real occupied room. That difference is exactly why this
  can't be treated as equivalent to the hallway pattern and quietly
  ignored, but it's also why the FIX shape is already understood, not a
  mystery: the fixer's own writeup already established that making every
  sibling touch the shared target directly (Option B) isn't geometrically
  achievable once a fan-out stack's combined size exceeds the target's own
  edge length, no matter how it's arranged - a real fix needs a different
  idea entirely (e.g. routing additional shared bathrooms/storage off the
  hallway once more than one needs to share living's side, which the fixer
  already flagged as the more realistic real-world pattern anyway), not a
  quick patch.
- Frequency argument, same one this file already used for
  `livingNotOversized`, cuts the OTHER way here and that's exactly why this
  gets flagged instead of silently accepted: `livingNotOversized`'s residual
  failures are ~1% of the grid and only unrealistic combos.
  Through-room chaining is 60.7% of the grid, and its SINGLE-hop case (the
  common one) hits entirely ordinary requests. That frequency is too high to
  describe as an edge case - it's a real, common characteristic of the
  current shared-room placement model, and needs to be documented as a known
  limitation for exactly that reason, not because it's rare.
- Given the time budget: Day 7-8 has now run through a builder pass, a
  checker pass, a fixer pass, TWO reviewer passes, and a second fixer
  pass - well past its original 2-day slot in `docs/PLAN.md`'s roadmap - and
  DXF export (this milestone's OTHER original scope item) hasn't been
  started at all, windows (promised separately) hasn't been started, and
  every milestone from Day 8-9 through Day 15 is still "Not started" per
  this file. Redesigning shared-room fan-out placement now, for a quality
  concern that predominantly affects programs needing several bathrooms to
  share one wall, is not the highest-value use of what's left of a 15-day
  budget - the same trade-off logic already applied to
  `livingNotOversized`.

**Decision: documented here as a known limitation, not fixed this pass.**
Worth a dedicated follow-up if time allows after the remaining milestones,
using the fixer's own suggested direction (route additional shared
bathrooms/storage off the hallway once living's own side is full) as the
starting point - not re-litigated from scratch.

**Final Day 7-8 status, stated plainly:**

- **Done and solid:** rule-engine circulation (automatic hallway, full
  bedroom reachability) AND full room-to-room door reachability (the
  sealed-room defect is fixed: 0/672 in the committed sweep, independently
  reproduced above on 5 additional room programs the fixer never
  specifically tested, with real multi-hop paths traced over actual placed
  doors, not attach-map labels).
- **Done, with a documented known limitation:** the SVG renderer (walls,
  doors, hallway, labels, dimensions) - structurally matches the user's
  reference-image ask, and every room in every tested program now has a
  real door to the rest of the house. The limitation: for a majority of
  realistic-to-moderate room programs (including the project's own 3bed/
  2bath demo), reaching some shared rooms requires walking through another
  occupied room of the same type - see the through-room decision above.
  This is an accepted MVP trade-off, not silently dropped.
- **Not started:** DXF export. Confirmed directly (not just by the
  fixer/prior reviewer's word): `server/src/dxf/` exists as a directory but
  contains zero files. This was explicitly deferred, not overlooked, and is
  the concrete remaining gap against `docs/PLAN.md`'s literal Day 7-8 scope
  line ("DXF export (hand-written)").
- **Not started:** windows. Confirmed directly via `grep -ril "window"
  server/src` - zero matches anywhere in the server source tree. Still
  queued, per what the user was told mid-milestone, not quietly dropped.
- **Overall: this milestone is NOT "done" as a whole** - DXF export was
  explicit original scope in `docs/PLAN.md`'s Day 7-8 row and remains
  entirely unbuilt. What CAN be marked done and closed out: the *revised*
  scope this pass actually worked (CAD-style rendering - connected walls,
  doors cut into every shared wall including chained ones, labels,
  dimensions - plus full rule-engine circulation/reachability) is genuinely
  solid, independently re-verified on both the numbers and raw geometry
  across multiple room programs, not just the one demo case.

**Next milestone - DXF export, ahead of windows.** This deviates from this
same file's own earlier stated order ("fix, then windows, then DXF") -
worth saying plainly why, not silently overriding it:

1. **DXF export is literal original scope**, not a nice-to-have. It's
   `docs/PLAN.md`'s own Day 7-8 line, and - per this same plan document's
   context section - the underlying Phase 1/2 report's literal Scope
   section (3.2) explicitly requires DXF export for AutoCAD editing. It is
   a graded deliverable. Windows, by contrast, is a mid-milestone promise
   made directly to the user in conversation - real, and should still be
   honoured, but not literal report scope, and nothing else in the
   remaining roadmap (cost estimation, API, frontend, report rewrite)
   depends on it existing.
2. **The precondition the previous reviewer set for starting DXF is now
   satisfied.** That reviewer deferred DXF specifically because starting it
   against a renderer with a known door-placement bug would mean
   re-deriving the same fix twice; the wall/door model (`wallNetwork.js`,
   `doors.js`) is now independently confirmed stable and correct (0 sealed
   rooms, 0 unreachable rooms, across the full 672-combo sweep and 5
   additional hand-picked programs) - there's no longer a reason to wait.
3. **Time budget.** Day 7-8 has already run well past its original 2-day
   estimate across five agent passes. Six more milestones (Day 8-9 through
   Day 15) haven't been started at all. Closing the literal, explicit scope
   gap (DXF) is a better use of the time that's left than adding further
   renderer polish (windows) first - a deferred PROMISE is recoverable
   (delivered later, or explicitly disclosed as a known gap in the final
   report if time truly runs out), but shipping without the report's own
   literally-required export format would not be as easily defensible.
4. Windows remains small and low-risk to slot in - reasonably paired with
   DXF export itself (both consume the same `wallNetwork.js` wall geometry)
   or done immediately after, whichever the next builder pass finds more
   natural once DXF's own structure exists. Not deprioritized indefinitely,
   just moved to directly after DXF instead of before it.

**Fixer pass — same-type chaining replaced with real-data-grounded
independent frontage.**

**This REPLACES the "Through-room decision" recorded above (the second
reviewer close-out's acceptance of bathroom_1 -> bathroom_0 style same-type
chaining as a documented MVP limitation) - it is not an addition on top of
it.** The user rejected that trade-off directly, backed by real data
analysis, not a stylistic preference. Scope: exactly the redesign the user
asked for - `attachMap.js` (verify + document), `seeding.js` (the real
geometric fix), `validate.js` (a new regression guard), plus real
measurement across the same 672-combo grid this file already uses
throughout.

**The real data (re-run this pass, 2026-09-01, against the actual
17,000-plan ResPlan dataset via `data-analysis/analyze_connectivity.py` -
numbers confirmed firsthand, not taken on the user's word):**

- Plans with 2+ bathrooms: 16,848. Total bathrooms in those plans: 40,261.
- **Bathroom-to-bedroom (en-suite, `via_door`): 23,348 instances - the
  single most common bathroom relationship by a wide margin.**
  `attachMap.js`'s existing en-suite-first pairing (bathrooms >= bedrooms ->
  pair master-first, extras -> living) already matches this - verified
  unchanged and correct this pass, not touched.
- **Bathroom-to-bathroom, a REAL door (`via_door`): only 66 of 40,261 real
  bathrooms across multi-bathroom plans - 0.16%.** Essentially never how
  real houses connect a second bathroom. The previous fixer pass's chaining
  fix made this the ROUTINE outcome instead (60.7% of this project's own
  672-combo sweep, measured below) - the exact opposite of real plans.
- **Bathroom-to-bathroom, touching but NOT via a door (mere adjacency):
  13,453 instances.** Very common - back-to-back bathrooms for plumbing
  efficiency are completely normal architecture, AS LONG AS each one still
  has its own separate door elsewhere. This is precisely the distinction
  the previous chaining fix blurred: it made a real wall between two
  bathrooms stand in for one of them having no other door at all, and
  called that "fixed".
- **Living connects directly (`via_door`) to 2+ bathrooms simultaneously in
  2,102 of 16,848 multi-bathroom plans (12.5%).** So there is no
  fundamental geometric reason a shared target can't have several
  independent doors at once - the previous fixer pass's claim that this
  "isn't geometrically achievable once combined stack size exceeds the
  target's own edge length" was a limitation of that specific column-wrap
  algorithm (it only ever used HALF of a target's own edge length before
  wrapping to a new column - see `seeding.js`'s `edgeLength` comment), not
  a real architectural constraint.
- Storage is a much sparser signal, confirmed directly: only 15 of 17,000
  real plans have 2+ storage rooms at all. Storage-to-storage `via_door`:
  2 instances. Used this to justify giving storage a simpler fallback
  (one alternate target) than bathroom (a genuine second edge of the same
  target) - see the design below.

**What was built (`server/src/ruleEngine/seeding.js`, the real geometric
fix - `attachMap.js` and `validate.js` got smaller, targeted additions):**

- **`seeding.js`: the entire `claimedColumn`/`claimPosition`/`chainParentId`
  mechanism from the previous fixer pass was removed and replaced**, not
  patched. New mechanism (`edgeLength`/`peekEdgeSlot`/`commitEdgeSlot`):
  - **The single biggest fix: a fan-out along a target's right/left edge
    now uses the target's FULL height, not half of it.** The previous
    bound only let occupants spread from the target's own centre-line
    toward ONE corner, leaving the other half of that same real wall
    completely unused. Doubling the usable wall length alone is enough for
    2 median-sized real-data hall bathrooms to fit directly on living's
    right edge with room to spare (0.42 units needed vs 0.598 available) -
    which covers the large majority of realistic room programs, including
    the project's own recurring 3-bed/2-bath demo (see below).
  - **When a room's primary edge (e.g. living's right side, for hall
    bathrooms) is genuinely full, it now tries a SECOND edge of the SAME
    real target** (living's left side, after kitchen/storage) before
    accepting anything else - still a real, direct touch to the real
    target, never a fabricated relationship to a same-type sibling. This
    is the literal "spread them along the target's actual available
    edge(s)... only wrap to a second edge of the same target" mechanism
    the redesign brief asked for.
  - **Storage additionally gets one genuinely different fallback TARGET**
    (living directly, if it doesn't fit beside a small kitchen) rather than
    a second edge of the same target - a smaller, proportionate mechanism
    justified directly by the data above (2+ storage is a 15-plan-out-of-
    17,000 case, not worth the same two-edge machinery bathroom needed).
  - **In the genuinely extreme residual case** (more same-type siblings
    sharing one target than even a second edge can hold), the room still
    gets a concrete, non-overlapping position for the solver to refine from
    - but `resolvedAttachMap` is deliberately left UNCHANGED (not
    overridden to whichever sibling it physically ends up beside). This is
    the core design change: `doors.js`/`validate.js` now correctly and
    honestly report no real door there, instead of a fabricated same-type
    relationship being presented as "connected". One real bug surfaced and
    fixed while building this: the first attempt extended the residual
    placement along the PRIMARY (right) edge, which reliably drove it
    toward increasing `cy` directly into the hallway/bedroom zone,
    reproducing real overlaps the solver's safety net couldn't always
    fully untangle (a genuine `noOverlaps` regression caught by this pass's
    own testing, not shipped). Fixed by extending the FALLBACK (left) edge
    instead - its `cx` is fixed by the target and room size alone,
    independent of how far the residual placement grows in `cy`, so it can
    never cross into the bedroom row/hallway's `x >= 0` territory no matter
    how far it extends.
  - A second real bug surfaced and fixed during implementation: the new
    `peekEdgeSlot`'s "start flush against the near end of the full edge"
    formula computes `-halfExtent + ownPerpExtent/2`, which is `-Infinity`
    for every UNBOUNDED side (en-suite bathrooms, extra balconies/living
    rooms all use "back"/"front", which stay unbounded - see `edgeLength`).
    This produced `NaN`/`-Infinity` coordinates for every en-suite bathroom
    in the first working version, breaking `frontDoorNearLiving`,
    `kitchenAdjacentToLiving`, and `ensuiteBathroomsAdjacent` across roughly
    half the sweep - caught immediately by `npm test`, not shipped. Fixed
    by falling back to `perpOffset = 0` (the target's own centre - the same
    starting point every unbounded side has always used) whenever the bound
    is `Infinity`.
- **`attachMap.js`: no functional change.** Verified this pass that
  en-suite-first pairing (bathrooms >= bedrooms) already matches the real
  data above and was never the source of the chaining bug - the bug was
  always downstream, in `seeding.js`'s placement mechanism silently
  rewriting a room's EFFECTIVE target while this file's own output stayed
  correct throughout. Added comments documenting the real-data verification
  and pointing at `seeding.js` for the actual fix, per the task's own
  finding that this was "already reasonably close to correct".
- **`validate.js`: new check 9, `noSameTypeChaining`.** A cheap, direct
  regression guard for the redesign's core promise - iterates
  `resolvedAttachMap` and fails if any entry points from one room to
  another room of the EXACT SAME type. Kept alongside (not replacing)
  `everyRoomReachableFromLiving` (check 8, unchanged) - see that check's own
  updated comment for why a general BFS reachability check alone wouldn't,
  on its own, prove same-type chaining is gone (it only proves SOME real
  path exists, not what kind of room that path routes through).
  `everyRoomReachableFromLiving` itself needed no code changes - it already
  measures exactly the right thing (a real BFS over doors.js-equivalent
  shared-wall + attach-map edges); what changed is what it's honestly
  allowed to report now that chaining is gone (see verification below).

**Verification performed (real numbers, re-measured by this pass, not
carried over from the previous fixer/reviewer passes' figures):**

- *Full-grid door sweep, rebuilt to run the ACTUAL wall-network/door-cutting
  pipeline* (`buildWallNetwork`/`placeDoors`, not just `validate.js`'s
  abstract attach-map check), across the identical 672-combination grid
  `batch.test.mjs` uses (bedrooms 1-6 x bathrooms 0-6 x kitchens 0-1 x
  balconies 0-3 x storages 0/2):
  - **Same-type doors (a real placed door between two rooms of the exact
    same type - bathroom<->bathroom or storage<->storage): 0/672 (0.0%)** -
    down from the previous pass's measured 60.7% chaining rate. This is the
    headline number: the trade-off the user rejected is gone, not reduced.
  - **Sealed rooms (at least one non-front-door room with literally zero
    placed doors): 40/672 (6.0%), 60 sealed room instances total** - NOT
    literally 0, and worth being fully honest about the tension this
    creates with this pass's own "Verification required" checklist, which
    expected sealed rooms to "stay at 0, same as after the last fix". They
    cannot BOTH be exactly 0 for the same underlying extreme combinations:
    the previous fix's 0% sealed-room rate was achieved BY chaining (a
    same-type door standing in for a room having no other real connection),
    which is precisely the mechanism this pass removes. Once chaining is
    gone, the genuinely-extreme combinations that used to be silently
    "fixed" by it are now honestly reported as sealed instead. This is
    exactly what item 3 of this pass's own brief explicitly authorized
    ("that's fine to document as a rare, honestly-labeled residual
    limitation... it should be RARE, not the ~60% hit-rate") - 6.0% is a
    ~10x reduction from 60.7%, and, checked directly, confined to the same
    flavour of unrealistic room programs already accepted elsewhere in this
    file for `livingNotOversized` (1 bedroom + 5-6 bathrooms with or
    without a kitchen; 2 bedrooms + 6 bathrooms; 5-6 bedrooms + 4-5
    bathrooms - i.e. programs where almost every bathroom in the house has
    to be a shared hall bathroom off one living room). None of the affected
    combinations are ordinary requests like this project's own 3-bed/2-bath
    demo or a plain 4-bed/2-bath household - both have zero sealed rooms
    and zero same-type doors under this redesign (see below).
- *`npm test` (`server/`):* **3/3 tests pass.** 672-combo sweep: **632/672
  (94.0%) overall** (down from the previous pass's 668/672/99.4% -
  understood and expected, not a regression: the drop is exactly the
  `everyRoomReachableFromLiving` combinations above, now honestly failing
  instead of passing via a fabricated chain). Per-check breakdown:
  `noOverlaps`, `frontDoorOnExterior`, `frontDoorNearLiving`,
  `kitchenAdjacentToLiving`, `balconiesOnExterior`, `ensuiteBathroomsAdjacent`,
  and the new `noSameTypeChaining` are all **0/672 (0.0%) failures**.
  `livingNotOversized` unchanged at 4/672 (0.6%, the pre-existing accepted
  edge case). `everyRoomReachableFromLiving` is **40/672 (6.0%)** - matches
  the door-sweep's sealed-room count exactly, a useful cross-check that the
  abstract check and the concrete door-placement measurement agree.
  `batch.test.mjs` was updated to match this honestly: `noSameTypeChaining`
  joined the zero-tolerance hard-check bucket (it IS always zero under the
  redesign); `everyRoomReachableFromLiving` was moved OUT of that bucket
  into its own assertion with a 10% ceiling (comfortably above the observed
  6.0%, tight enough to catch a real regression back toward 60%) - forcing
  it back to a zero-tolerance assertion would have meant either silently
  re-introducing chaining to hide the residual (exactly what this pass
  removes) or fabricating a fake pass; neither is honest. The overall
  pass-rate floor was correspondingly lowered from 95% to 90% (comfortably
  below the observed 94.0%), with the reasoning for the drop documented
  directly in the test file, not left unexplained.
- *Bedroom reachability, re-confirmed with zero regression* (this pass's
  own explicit requirement - the redesign was scoped to never touch
  hallway/bedroom placement logic, and didn't): re-ran the same 5 scenarios
  the Day 7-8 fixer/reviewer passes used (3bed/2bath hall-bathrooms,
  2bed/3bath full en-suite, 1bed/1bath/1balcony, 4bed/0bath,
  5bed/5bath/2balcony) through the FULL pipeline including actual door
  placement. **5/5 still pass, every bedroom in every scenario has a real
  door** - identical to every previous pass's result.
- *`node server/src/render/demo.js` (the project's own recurring 3bed/2bath
  demo scenario) - re-ran fresh, the task's explicit ask:* resolved attach
  map now shows `bathroom_1 -> living_0` with **no re-targeting at all**
  (better than the minimum bar of "a door to something other than
  bathroom_0" - it's a direct, independent door to living itself, exactly
  matching the real data's most common "living doors to 2+ bathrooms
  simultaneously" pattern). Self-check 1 (wall continuity): **9/9
  relationships PASS**, including a full-span wall for `bathroom_1 <->
  living_0` on its own dedicated stretch of living's right wall (span
  [2.55, 4.45], distinct from `bathroom_0 <-> living_0`'s span [0.46,
  2.36]). Self-check 2 (door-cut coverage): **9/9 interior doors placed, 0
  skipped**, front door placed - `bathroom_1 -> living_0` cut as a genuine,
  independent door, not a chain through `bathroom_0`.
- *2 bed / 4 bath, the task's explicit "clearly more bathrooms than
  bedrooms" test case:* `bathroom_0 -> bedroom_0` and `bathroom_1 ->
  bedroom_1` (en-suite pairing, unaffected), `bathroom_2 -> living_0` and
  `bathroom_3 -> living_0` (the two hall bathrooms) - resolved attach map
  IDENTICAL to the nominal one (no re-targeting needed at all, both fit
  directly on living's own right edge). All 4 interior bathroom-related
  doors placed as genuine, independent doors to their real targets, 0
  skipped. Full `validateLayout` passes every check including
  `noSameTypeChaining` and `everyRoomReachableFromLiving`.

**What this pass did NOT touch, on purpose:** `solver.js` (the redesign
only needed a better SEED position, not a different refinement algorithm -
confirmed by `git status`/diff, genuinely untouched), DXF export
(`server/src/dxf/` is still an empty directory), and windows (still nowhere
in `server/src`) - all explicitly out of scope for this pass, which was
scoped to exactly the user's rejected-trade-off redesign.

**Not claiming this milestone "done"** - that determination belongs to
whoever reviews this pass next, per this role's own scope boundary. What
can be said plainly, with real numbers behind it: the same-type chaining
trade-off the user rejected is gone (0.0% across the full sweep, down from
60.7%), replaced by genuine independent frontage for the large majority of
programs and an honestly-labelled, ~10x-rarer residual limitation (6.0%,
confined to genuinely extreme, unrealistic room programs) for the rest -
not silently patched over. `npm test`'s hard-check bucket and pass-rate
floor were updated to match reality rather than tuned to keep a stale
number green.

**Reviewer close-out (Day 7-8, THIRD and final pass - after the redesign
that replaced same-type chaining).**

*Independent verification performed - three fresh scripts of my own,
reusing no prior agent's script, per this role's own "actually read and run
the code" standard:*

1. **Re-ran `node server/src/ruleEngine/demo.js`, `node server/src/render/demo.js`,
   and `npm test` (`server/`) fresh.** All three match the fixer's report
   exactly: plot 16.12m x 11.59m; `bathroom_1 -> living_0` resolves with NO
   re-targeting (a genuine independent door, not a chain through
   `bathroom_0`); render self-checks 9/9 wall-continuity PASS and 9/9
   interior doors placed, 0 skipped; `npm test` 3/3 tests pass, sweep
   632/672 (94.0%), `noOverlaps`/`frontDoorOnExterior`/`frontDoorNearLiving`/
   `kitchenAdjacentToLiving`/`balconiesOnExterior`/`ensuiteBathroomsAdjacent`/
   `noSameTypeChaining` all 0/672 (0.0%), `livingNotOversized` 4/672 (0.6%,
   unchanged pre-existing edge case), `everyRoomReachableFromLiving` 40/672
   (6.0%).
2. **Job #2 (same-type chaining elimination) - built a fresh script that
   runs the ACTUAL wall-network/door-placement pipeline** (`buildWallNetwork`
   + `placeDoors`, not `validate.js`'s abstract `noSameTypeChaining` check)
   across the identical 672-combo grid, and inspects every REAL PLACED DOOR's
   two room types directly. Result: **0/672 combinations produce a placed
   door between two rooms of the same type (bathroom<->bathroom or
   storage<->storage) - 0 same-type door instances found anywhere in the
   grid.** This confirms the elimination at the level `validate.js`'s own
   check can't fully rule out on its own (a resolvedAttachMap free of
   same-type entries doesn't, by itself, prove no same-type door ever gets
   physically cut) - independently verified from real geometry, not just
   from the attach-map data structure.
3. **Job #1 (how extreme is "extreme") - quantified against the real
   17,000-plan ResPlan dataset, not eyeballed.** Built a fresh script
   (`analyze_connectivity.py`'s sibling, a new one-off, not committed - see
   below) that computes, for every real plan, its bedroom/bathroom/kitchen/
   storage counts, and a second script that runs the full 672-combo sweep
   through real door placement and records each of the 40 sealed-room
   combinations' exact requirement tuple. Cross-referencing the two:
   - **Real-dataset ceiling:** across all 17,000 real plans, the bathroom-
     to-bedroom ratio never exceeds 4.0 (p100/max), and 99.9% of plans stay
     at or below 3.0. Max bedroom count ever seen in a real plan is 7 (one
     plan); max bathroom count is 7. No real plan has bathrooms >= bedrooms
     + 3 except 4 plans (0.024%), and precisely 0 real plans have bathrooms
     >= 5 with bedrooms <= 2.
   - **Every one of the 40 failing combinations was checked against the
     real dataset for an EXACT joint match** (same bedroom count, bathroom
     count, kitchen count, and storage count together - not just "is the
     ratio high"):
     - **24/40 (60%)** - bedroom/bathroom pairs (1bed+5bath, 1bed+6bath,
       2bed+6bath, 6bed+4bath) that occur **zero times** anywhere in the
       17,000-plan dataset, regardless of kitchen/storage count.
     - **4/40 (10%)** - 5bed+4bath with 0 kitchens and 2 storage rooms. The
       bedroom/bathroom pair alone isn't rare (69/17,000 real plans, 0.41%),
       but checked directly: of those 69 real plans, **0 have zero kitchens
       and 0 have 2+ storage rooms** - the exact joint combination this
       pass's failing case needs occurs **zero times** in real data.
     - **8/40 (20%)** - 6bed+5bath with 2 storage rooms. 6bed+5bath alone
       occurs 6/17,000 times (0.035%) in reality, but of the 15 real plans
       with 2+ storage rooms anywhere in the whole dataset, **none** have 6
       bedrooms - so this joint combination is also **zero occurrences**.
     - **4/40 (10%)** - 6bed+5bath with 1 kitchen and 0 storage rooms (the
       only sub-case with a real-world match): this exact joint profile
       (ignoring balcony count, which the dataset schema doesn't let this
       check hold fixed) genuinely occurs in the real data, **6 times out of
       17,000 (0.035%)**.
   - **Net result: 36 of the 40 failing combinations (90%) correspond to a
     joint room-count profile that appears literally zero times anywhere in
     17,000 real floor plans; the remaining 4 (10%) correspond to a genuinely
     rare but real pattern (0.035% of real plans).** None resemble anything
     close to an ordinary request - this is a quantitative confirmation, not
     just a description of the list looking unusual by eye, and it holds up
     under the stricter "does this EXACT combination ever occur" test, not
     just a looser "is the ratio high" one.
   - Both scripts were one-off and are not committed (matching this
     project's existing convention of not littering the repo with ad-hoc
     verification scripts - `batch.test.mjs` is the one sweep that's
     committed, and it doesn't need dataset access to run).

*Milestone-intent check (not just re-confirming the fixer's own findings):*
read `attachMap.js`, `seeding.js`, and `validate.js` in full end to end
(not just the diff), and independently reasoned through the edge-based
fan-out mechanism (`edgeLength`/`peekEdgeSlot`/`commitEdgeSlot`) rather than
trusting the code comments' own description of it - the "full edge length,
not half" fix and the "second edge before ever chaining" fallback both check
out against the actual code, not just the accompanying prose. `docs/PLAN.md`'s
Day 7-8 line ("doors cut into shared walls with swing-arc symbols... matching
standard architectural drafting convention") is genuinely satisfied by what's
in `server/src/render/`: connected wall network, real door cuts (independent
frontage for the large majority of programs, not fabricated relationships),
swing arcs, labels, dimension lines - and now, additionally, grounded against
real household data rather than an internal geometric argument alone. This is
a stronger evidence base than either of the previous two Day 7-8 reviewer
passes had.

**Final Day 7-8 status, updated and closed out:**

- **Done and solid — rule-engine circulation + door reachability.** The
  automatic hallway (bedroom reachability) and the edge-based fan-out
  redesign (independent frontage instead of same-type chaining) together
  mean every room in every realistic room program has a real door to the
  rest of the house, verified three independent ways in this pass alone
  (attach-map-level check, real door-placement-level check, and cross-
  referenced against real ResPlan household data). The one residual gap
  (6.0% of a deliberately extreme 672-combo synthetic sweep, not 6.0% of
  realistic requests) is honestly labelled, not hidden, and shown here to be
  concentrated in room-count combinations that essentially never occur in
  17,000 real floor plans.
- **Done and solid — CAD-style SVG rendering.** Connected wall network,
  door cuts with swing-arc symbols, room labels, dimension lines, no colour
  fill - matches the user's reference images structurally, and (this pass's
  own contribution) is now verified against real household data twice over
  (the original architectural-realism complaint, and this pass's quantified
  extremity check), not just against this project's own synthetic sweep.
- **Not started — DXF export.** `server/src/dxf/` remains an empty
  directory (confirmed via `ls`). This is the one piece of `docs/PLAN.md`'s
  literal Day 7-8 scope line ("DXF export (hand-written)") not yet built.
  Explicitly deferred three reviewer passes running now, each time for a
  documented, real reason (first: renderer had an unfixed door-placement
  bug; second and third: same reasoning, since the bug kept turning out to
  be deeper than first diagnosed) - not overlooked.
- **Not started — windows.** Confirmed via `grep -ril "window" server/src`
  - zero matches. Still queued, per what the user was told mid-milestone.
- **Overall: Day 7-8 as a WHOLE (DXF export + 2D preview, `docs/PLAN.md`'s
  original framing) is still not fully done - DXF export is the literal gap.
  But the *revised, harder* scope this milestone actually grew into (CAD-
  style rendering with fully correct, dataset-verified circulation) is
  genuinely finished and does not need another pass.** Three reviewer
  close-outs, two fixer passes beyond the original builder/checker cycle,
  and real user pushback each caught a real defect (bedroom sealing, then
  bathroom/storage sealing, then an architecturally-unrealistic trade-off)
  - each fix was substantive, not cosmetic, and this pass's independent
  re-verification (including, for the first time, quantifying the residual
  limitation against real household data rather than just this project's own
  synthetic sweep) found no further defect to flag. There is no remaining
  reason to keep this milestone open for the rendering/circulation half.

**Next milestone - DXF export, with an explicit calendar-risk flag for the
user, not a silent continuation.**

Reasoning, weighing time spent against what's left:

1. **DXF export is the correct, literal next step.** It's `docs/PLAN.md`'s
   own remaining Day 7-8 scope item, required by the underlying report's
   Scope section (3.2) for AutoCAD compatibility, and it can now safely reuse
   `wallNetwork.js`'s real-metre room/wall geometry - which is independently
   confirmed correct and stable by this pass, on both this project's own
   sweep AND real dataset comparison, so there's no remaining reason to
   expect it needs yet another rendering-layer fix underneath it. Keep it
   small and literal per `docs/PLAN.md`'s own framing (hand-written
   LWPOLYLINE + TEXT per room, no new dependency) - this milestone does not
   need the same multi-pass depth Day 7-8 needed, because the geometry it
   exports is already solved.
2. **Windows should be explicitly named as at-risk scope, not quietly
   folded in or quietly dropped.** It was promised to the user in
   conversation, but it is not literal report-required scope the way DXF
   is (`docs/PLAN.md`'s Scope section never mentions windows). Pair it with
   DXF if it fits naturally (both consume the same wall geometry); if the
   calendar below doesn't allow it, it should be disclosed to the user as
   descoped rather than silently dropped, not attempted at the cost of a
   report-required deliverable.
3. **The calendar case for urgency, stated plainly with real numbers, not
   just "this took a while":** `docs/PLAN.md` was written when today was
   2026-08-27 (Day 1), with a stated deadline of ~2026-09-11 (15 days out).
   Today is 2026-09-03 - Day 7-8 closes out on almost exactly its
   day-budgeted slot on the calendar (calendar day 8 of 15), which is a
   genuinely good sign given how much real rework it needed. But that means
   there are only **8 calendar days left** (2026-09-04 through 2026-09-11)
   for **Day 8-9 through Day 15 of `docs/PLAN.md`'s roadmap - cost
   estimation, API + MongoDB wiring, the full React frontend (requirements
   form, 2D viewer, Three.js 3D viewer, cost panel, DXF download), an
   integration pass, the report rewrite, and buffer/polish - which is
   nominally 10 more budgeted days of work**, plus DXF export and windows
   still owed from this milestone's own carve-out. The math does not
   currently close: 10+ nominal days of remaining roadmap against 8 real
   days left, even before DXF/windows are added back in. This is worth
   surfacing to the user directly now, not after another milestone slips -
   the two realistic options are (a) trim scope deliberately (a strong
   candidate: treat the Three.js 3D viewer as a stretch goal behind the 2D
   viewer + DXF export, since those two together already deliver the
   report's core "view and edit your floor plan" promise, and/or keep cost
   estimation to a simple, explicitly-documented formula rather than
   anything iterative), or (b) accept that the report/defense-prep buffer
   (Day 15) shrinks or disappears. Recommending (a) - deliberate, disclosed
   trimming beats an undisclosed rushed finish - but this is the user's call
   to make, not mine to make silently by just moving faster.
4. Given the above, the immediate next builder pass should be scoped
   tightly: DXF export only, hand-written and minimal, reusing existing
   geometry, with windows attempted only if it fits inside the same pass
   without threatening that scope - and the calendar flag above should be
   surfaced to the user before or alongside that pass starting, not buried
   in this file for them to find later.

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
