// constants.js
//
// Loads the mined dataset statistics (data-analysis/output/rule-constants.seed.json,
// produced once by data-analysis/seed_stats.py from 17,000 real ResPlan floor plans)
// and turns them into the three lookup tables the rest of the rule engine is built
// on: ROOM_TYPES, SIZE_RANGES and PRIORITY. Everything here runs once, at module
// load time (the file is read from disk exactly once, the first time anything
// imports this module) - there is nothing per-request to recompute.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// --------------------------------------------------------------------------
// Resolve and read the seed JSON file.
//
// import.meta.url is the file:// URL of THIS file (constants.js). We convert
// it to a normal filesystem path with fileURLToPath, take its directory, and
// walk up three levels (ruleEngine -> src -> server -> repo root) to find
// data-analysis/output/rule-constants.seed.json. Using import.meta.url
// (rather than process.cwd()) means this works no matter which directory
// `node` happens to be launched from.
// --------------------------------------------------------------------------
const thisFileDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisFileDir, "..", "..", "..");
const seedPath = path.join(
  repoRoot,
  "data-analysis",
  "output",
  "rule-constants.seed.json"
);

const seed = JSON.parse(readFileSync(seedPath, "utf-8"));

// --------------------------------------------------------------------------
// ROOM_TYPES
// --------------------------------------------------------------------------
// The full list of room categories the generator knows how to place.
//
// The seed data also has a "stair" type (staircases appear in some of the
// 17,000 ResPlan source plans), but staircases are deliberately dropped
// here - out of scope for this project, exactly like the earlier hybrid
// project's own MVP decision. A staircase needs multi-storey awareness (which
// floor it connects to, matching footprints across two floors, code-mandated
// clearances/headroom) that a single-storey room-box generator simply has no
// way to reason about. Dropping it here is a deliberate choice, not an
// oversight - silently treating "stair" like any other room would produce a
// box with no real meaning.
export const ROOM_TYPES = [
  "bedroom",
  "bathroom",
  "kitchen",
  "living",
  "balcony",
  "storage",
  "front_door",
];

// --------------------------------------------------------------------------
// SIZE_RANGES
// --------------------------------------------------------------------------
// For each room type, how big a share of the home's TOTAL built room area
// (the sum of every room's area in a plan) that type typically occupies, as
// a fraction between 0 and 1. Derived from seed.size_ratio_by_type[type]:
//   min    <- p10 (10th percentile, across 17,000-40,000+ real rooms of
//              that type in the dataset)
//   target <- median (50th percentile)
//   max    <- p90 (90th percentile)
//
// We use these percentiles instead of the raw min/max the seed JSON also
// reports because the raw extremes are degenerate outliers, not real rooms:
// some source polygons in ResPlan are essentially zero-area artifacts from
// bad/noisy source data (e.g. front_door's raw min ratio is 2.4e-17 - a
// mathematical sliver, not an actual doorway). Building SIZE_RANGES off
// those would make "min size" meaningless. p10/p90 describe the middle 80%
// of REAL rooms and are what the rest of the engine treats as "normal".
export const SIZE_RANGES = {};
for (const type of ROOM_TYPES) {
  const stats = seed.size_ratio_by_type[type];
  if (!stats) {
    // Fail loudly at startup rather than silently producing an undefined
    // SIZE_RANGES entry that would only blow up later, deep inside seeding
    // or the solver, somewhere much harder to debug.
    throw new Error(
      `constants.js: rule-constants.seed.json has no size_ratio_by_type entry for "${type}"`
    );
  }
  SIZE_RANGES[type] = {
    min: stats.p10,
    target: stats.median,
    max: stats.p90,
  };
}

// --------------------------------------------------------------------------
// ASPECT_RATIO_BY_TYPE
// --------------------------------------------------------------------------
// For each room type, the typical LONG-side:SHORT-side ratio of real rooms
// of that type, mined the same way SIZE_RANGES is - from
// seed.aspect_ratio_by_type[type].median (the 50th percentile long:short
// ratio across every real room of that type in the 17,000-plan ResPlan
// dataset). seed_stats.py computes this per real room polygon as
// max(bbox_w, bbox_h) / min(bbox_w, bbox_h), so a value of exactly 1.0 would
// mean "perfectly square" and every value here is >= 1.0 by construction.
//
// This exists to fix a real, visible bug (found by actually looking at a
// rendered floor plan, not just checking the geometry self-checks): before
// this constant existed, seeding.js's sizeOf() gave every room a plain
// SQUARE shape (side = sqrt(area)) - the right AREA, but a shape essentially
// no real room actually has. Real bedrooms are close to square (median
// ratio ~1.19) but real bathrooms/kitchens/living rooms are visibly
// rectangular (~1.28-1.58), and balconies are narrow strips (~2.34). Only
// the median is exported (not min/target/max the way SIZE_RANGES is) -
// seeding.js only ever needs ONE ratio per room (there's no equivalent of
// "min/max size" here, just "the typical proportion"), so a single
// representative figure is all this needs to be.
//
// We use the median rather than the mean for the same reason SIZE_RANGES
// uses percentiles instead of raw stats elsewhere in this file: it's not
// pulled around by a handful of extreme/degenerate source polygons.
export const ASPECT_RATIO_BY_TYPE = {};
for (const type of ROOM_TYPES) {
  const stats = seed.aspect_ratio_by_type?.[type];
  if (!stats) {
    // Same "fail loudly at startup" reasoning as the SIZE_RANGES loop above -
    // a silently-missing ratio would otherwise only surface as a mysterious
    // NaN deep inside seeding.js.
    throw new Error(
      `constants.js: rule-constants.seed.json has no aspect_ratio_by_type entry for "${type}"`
    );
  }
  ASPECT_RATIO_BY_TYPE[type] = stats.median;
}

// --------------------------------------------------------------------------
// MASTER_BEDROOM_AREA_BOOST
// --------------------------------------------------------------------------
// How much bigger a real plan's largest bedroom typically is than the
// AVERAGE of that same plan's other bedrooms - seed.master_bedroom_area_boost
// (a new field seed_stats.py mines by comparing, within each real multi-
// bedroom plan, its biggest bedroom's area against the mean area of every
// OTHER bedroom in that same plan). Median 1.18, i.e. a real master bedroom
// is typically about 18% bigger than its plan's other bedrooms' average -
// not dramatically bigger, but a real, consistent, measurable effect across
// the dataset, not a rounding artifact (p10 1.04, p90 1.47 - see the seed
// JSON directly).
//
// This exists to fix the second half of the same "every room looks
// identical" visual bug ASPECT_RATIO_BY_TYPE fixes: before this constant
// existed, every bedroom in a plan (master or not) got the exact same
// SIZE_RANGES.bedroom.target area, so a 3-bedroom plan always rendered 3
// IDENTICALLY-sized bedrooms - immediately readable as unrealistic in the
// rendered image, and not what any real floor plan does. See seeding.js's
// bedroom-placement block for where this actually gets applied (only to
// bedroom_0, the "master" by this project's existing declaration-order
// convention - see attachMap.js's own comment on why there's no predicted
// size to rank by here).
export const MASTER_BEDROOM_AREA_BOOST = seed.master_bedroom_area_boost.median;

// --------------------------------------------------------------------------
// HALLWAY_DEPTH_M
// --------------------------------------------------------------------------
// `hallway` is a new, always-present room type (see roomProgram.js) added
// in this pass to close a real gap the checker found: attachMap.js used to
// give bedrooms no relationship of their OWN pointing back toward living at
// all (a bedroom was only ever a TARGET - for an en-suite bathroom or a
// balcony - never a source), so a bedroom could be fully geometrically
// sealed off with zero doors to the rest of the house. A hallway is the
// fix: a shared connector that borders living on one side and the whole
// bedroom row on the other, the same way the user's own reference floor
// plans show one.
//
// hallway is deliberately NOT added to ROOM_TYPES/SIZE_RANGES above. Those
// two exports are built entirely from seed.size_ratio_by_type, and the
// ResPlan dataset this project mines has no "hallway" room type at all -
// checked directly, not assumed: data-analysis/output/rule-constants.seed.json's
// room_type_frequency only ever had bedroom/bathroom/balcony/living/
// front_door/kitchen/storage/stair keys, no "hallway" among them. There is
// no real-world percentile to derive a size fraction from here the way
// every other room type gets one.
//
// A hallway also isn't sized the way every other room here is anyway.
// Every other type gets a SQUARE whose AREA is a fixed fraction of the
// whole plan (see sizeOf() in seeding.js), which makes no architectural
// sense for a corridor: a corridor's defining dimension is its DEPTH (how
// far you walk sideways to step from the bedroom row into it), which real
// buildings hold to a narrow, fairly constant figure regardless of how big
// the home is - while its WIDTH has to span however wide the specific
// bedroom row it serves turns out to be. That's a genuinely different
// sizing rule (fixed depth + measured width), not a fraction-of-total-area
// rule, so it gets its own dedicated constant here instead of a
// SIZE_RANGES entry - see seeding.js for where this actually gets turned
// into a placed box.
//
// 1.2m is close to the practical minimum a residential corridor needs
// (enough for one person to walk through comfortably, per standard
// accessibility/building-code guidance); 1.5m is comfortably generous.
// 1.35m (the midpoint) is used as a single fixed value rather than a
// range, matching how every other room type here is also always seeded at
// exactly its own single "target" figure, never something else within its
// min/target/max band (see sizeOf() in seeding.js).
export const HALLWAY_DEPTH_M = 1.35;

// --------------------------------------------------------------------------
// AVG_OTHER_ROOMS_PER_PLAN
// --------------------------------------------------------------------------
// How many NON-LIVING rooms a real ResPlan plan has on average. This exists
// for exactly one consumer - validate.js's "living room isn't oversized"
// check - which needs to correct for a specific mismatch: SIZE_RANGES.living
// fractions are living's share of a plan's TOTAL built area, mined across
// 17,000 plans whose room counts vary quite a bit. A room PROGRAM with far
// fewer "other" rooms than this average will mechanically show living
// claiming a bigger slice of its own (smaller) total - not because anything
// placed it wrong, but because there are fewer other rooms diluting the
// total. See validate.js for how this gets turned into a room-count-aware
// threshold instead of one flat number.
//
// Computed here from the same mined frequency data everything else in this
// file already trusts (seed.room_type_frequency / seed.plan_count), rather
// than hand-picked, so the "typical plan size" this correction assumes
// matches the dataset's real average instead of a guessed round number.
// Deliberately uses the RAW frequency table (which still includes "stair",
// even though ROOM_TYPES above drops it) rather than summing ROOM_TYPES:
// seed_stats.py's size_ratio_by_type computed each plan's total built area
// from every room actually in that plan, stairs included where present, so
// matching that same total here keeps this average consistent with the
// denominator SIZE_RANGES.living.max was itself derived from.
const totalRoomInstances = Object.values(seed.room_type_frequency).reduce(
  (sum, count) => sum + count,
  0
);
const livingInstances = seed.room_type_frequency.living ?? 0;
export const AVG_OTHER_ROOMS_PER_PLAN =
  (totalRoomInstances - livingInstances) / seed.plan_count;

// --------------------------------------------------------------------------
// PRIORITY
// --------------------------------------------------------------------------
// Controls both the order seeding.js places rooms in, and the order
// solver.js re-examines them when fixing collisions/relationships. Higher
// number = settled earlier = more architecturally "load-bearing", in the
// sense that everything else in the plan is positioned relative to it, so
// once it's placed it should be disturbed as little as possible.
//
// The ordering logic, tier by tier:
//   living (100)    - the public zone. Every other room type below is
//                      positioned relative to living (directly, or
//                      indirectly through another room that itself attaches
//                      to living), so it has to be placed - and then left
//                      alone - before anything else can sensibly be placed.
//   bedroom (85)    - the private zone. Needs living placed first (bedrooms
//                      sit "behind" it), but nothing else needs bedrooms
//                      placed first except hallway, which comes next.
//   hallway (80)    - the shared connector between the bedroom zone and
//                      living (see HALLWAY_DEPTH_M above), added in this
//                      pass. Has to be placed AFTER the bedroom row (its
//                      own width is measured from wherever the bedrooms
//                      actually ended up), so it sits just below bedroom in
//                      this tier list - but still ranks above bathroom,
//                      kitchen, storage and balcony, since those rooms'
//                      seeded positions must never be allowed to shove a
//                      hallway off the exact, by-construction shared wall
//                      it was placed to have with every bedroom (a bathroom
//                      or balcony colliding with the hallway is THEIR
//                      problem to yield on, not the hallway's - see
//                      isRelevantCollider in solver.js).
//   bathroom (70)   - attaches to a specific bedroom (en-suite) or to living
//                      (shared hall bathroom) - either way it needs its
//                      target to already exist, so it comes after both.
//   kitchen (60)    - a service room hung off living. Doesn't affect where
//                      the bedroom/bathroom zone goes, so it can settle
//                      after the private zone without disturbing it.
//   storage (40)    - attaches to kitchen if there is one, else living.
//                      Lowest-stakes interior room - settles last among the
//                      "interior" room types.
//   balcony (25)    - an exterior room hung off its attach target (the
//                      master bedroom, or living for extra balconies).
//                      Needs that target placed first, and has the weakest
//                      positional requirement of any room ("touch some
//                      outside edge" rather than a specific spot).
//   front_door (10) - the entrance. Only needs living to exist and the
//                      plot's front edge to be known, both already true
//                      once every room above has settled, so it is always
//                      placed last.
export const PRIORITY = {
  living: 100,
  bedroom: 85,
  hallway: 80,
  bathroom: 70,
  kitchen: 60,
  storage: 40,
  balcony: 25,
  front_door: 10,
};
