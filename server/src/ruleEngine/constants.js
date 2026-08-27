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
//                      placed first except bathrooms, which come next.
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
  bathroom: 70,
  kitchen: 60,
  storage: 40,
  balcony: 25,
  front_door: 10,
};
