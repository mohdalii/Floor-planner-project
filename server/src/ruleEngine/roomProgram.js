// roomProgram.js
//
// Turns a user's plain-language requirements ("3 bedrooms, 2 bathrooms, ...")
// into the flat list of room objects every later stage of the rule engine
// works from. This is the ONLY place user input gets validated and
// defaulted - everything downstream (attachMap.js, seeding.js, solver.js)
// trusts the room list it receives here and never re-checks counts itself.

import { ROOM_TYPES } from "./constants.js";

// Maps each user-facing requirement field to the internal room "type" name
// used everywhere else in the rule engine (constants.js, PRIORITY, etc).
// front_door has no requirement field - a home always gets exactly one, it
// isn't something the user chooses - so it's handled separately below
// rather than appearing in this table.
const REQUIREMENT_KEY_BY_TYPE = {
  bedroom: "bedrooms",
  bathroom: "bathrooms",
  kitchen: "kitchens",
  living: "livingRooms",
  balcony: "balconies",
  storage: "storages",
};

// Defaults used when the caller omits a field entirely (undefined/null), as
// opposed to explicitly asking for 0 of something (which is left as 0).
const DEFAULT_COUNTS = {
  bedrooms: 1,
  bathrooms: 1,
  kitchens: 1,
  livingRooms: 1,
  balconies: 0,
  storages: 0,
};

// A real home needs at least one of each of these - a floor plan with zero
// bedrooms, zero bathrooms, or zero living space isn't really a "home"
// layout at all. Requests for fewer than this are clamped up to the
// minimum rather than rejected outright: an under-specified request feels
// like a minor input slip, not nonsense worth throwing an error over.
const MINIMUM_COUNTS = {
  bedrooms: 1,
  bathrooms: 1,
  livingRooms: 1,
};

/**
 * Validate and fill in a user's room requirements, returning a flat list of
 * room objects ready for the rest of the rule engine:
 *   { id: "bedroom_0", type: "bedroom", typeIndex: 0 }
 *
 * `requirements` counts (all optional, all default to a sensible value):
 *   { bedrooms, bathrooms, kitchens, livingRooms, balconies, storages }
 *
 * A negative count is treated as nonsensical input and throws - there's no
 * reasonable way to guess what "-2 bedrooms" was supposed to mean, so we
 * don't try. Anything else (missing fields, fractional counts, zero for a
 * non-minimum field) is handled with a default/clamp rather than an error,
 * since none of those are actually invalid business requests.
 *
 * @param {object} [requirements]
 * @returns {Array<{id: string, type: string, typeIndex: number}>}
 */
export function buildRoomProgram(requirements = {}) {
  const counts = {};

  // Step 1: resolve every count field to a concrete non-negative integer,
  // applying the default when a field was left out entirely.
  for (const key of Object.keys(DEFAULT_COUNTS)) {
    const raw = requirements[key];

    if (raw === undefined || raw === null) {
      counts[key] = DEFAULT_COUNTS[key];
      continue;
    }

    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
      throw new Error(
        `buildRoomProgram: "${key}" must be a non-negative number, got ${JSON.stringify(raw)}`
      );
    }

    // Room counts are whole rooms - truncate any fractional input (e.g. a
    // stray "2.5" typed into a form field) rather than rejecting it.
    counts[key] = Math.floor(raw);
  }

  // Step 2: enforce the "a home needs at least one of these" floor.
  for (const key of Object.keys(MINIMUM_COUNTS)) {
    counts[key] = Math.max(MINIMUM_COUNTS[key], counts[key]);
  }

  // Step 2b: cap livingRooms at exactly 1 - a deliberate MVP scope decision
  // (reviewer pass, Day 3-5 close-out), not an oversight. docs/PLAN.md and
  // the underlying report only ever require a single "living area" per
  // home; multi-living-room support (a second/third lounge, each attaching
  // to the main one - see attachMap.js/seeding.js, which still contain that
  // logic) was the builder's own extension beyond the literal spec. The
  // real ResPlan dataset backs up capping it here: 16,999 of the 17,000
  // real plans it was mined from have exactly 1 living room
  // (data-analysis/output/rule-constants.seed.json's
  // room_type_frequency.living vs plan_count - see constants.js). Multi-
  // living also introduced two concrete problems the single-living case
  // never has (a narrow residual seeding collision, and every extra living
  // room getting the same full median size, tripping the oversized check on
  // ~90% of sampled multi-living programs - see STATUS.md Day 3-5). With a
  // 15-day budget and DXF/cost/API/frontend/report still ahead, this cap
  // removes those edge cases entirely rather than spending more time
  // chasing them, and matches how real homes are actually requested. The
  // downstream multi-living code is left in place (harmless, and a
  // reasonable base for un-capping this later) rather than deleted.
  counts.livingRooms = Math.min(1, counts.livingRooms);

  // Step 3: expand the counts into a flat list of room objects, walking
  // ROOM_TYPES so the output order is always the same for the same input.
  // typeIndex is the room's position within its own type (bedroom_0,
  // bedroom_1, ...) - later stages (attachMap.js) use typeIndex 0 as "the
  // first/master" instance of a type.
  const rooms = [];
  for (const type of ROOM_TYPES) {
    if (type === "front_door") continue; // handled explicitly below - always exactly 1
    const requirementKey = REQUIREMENT_KEY_BY_TYPE[type];
    const count = counts[requirementKey];
    for (let typeIndex = 0; typeIndex < count; typeIndex++) {
      rooms.push({ id: `${type}_${typeIndex}`, type, typeIndex });
    }
  }

  // Every home has exactly one main entrance - this isn't a count the user
  // supplies, so it's added unconditionally rather than read from
  // `requirements`.
  rooms.push({ id: "front_door_0", type: "front_door", typeIndex: 0 });

  return rooms;
}
