// validate.js
//
// A READ-ONLY checklist run AFTER solveLayout() has produced a final
// layout. It never changes anything - its only job is to answer "is this
// actually usable as a home", the same way a human reviewing a finished
// floor plan would sanity-check it before signing off on it. Ported
// conceptually from the earlier hybrid project's validate_layout() (see
// docs/PLAN.md for the source reference).
//
// Each check below is commented with the real-world usability problem it's
// catching - not just what the code mechanically does, but WHY a plan that
// fails it would actually be a bad floor plan to hand someone.

import { SIZE_RANGES, AVG_OTHER_ROOMS_PER_PLAN } from "./constants.js";

// These three tolerances intentionally match solver.js's COLLISION_EPS /
// ADJACENCY_TOLERANCE / EXTERIOR_TOLERANCE (re-declared here rather than
// imported, so this file stays fully self-contained and readable on its
// own - see solver.js for the fuller explanation of what each one means).
// Using the SAME tolerance the solver used to decide "close enough" means
// a layout the solver considers resolved will actually PASS these checks,
// instead of validate.js silently being stricter than what solveLayout()
// was even trying to achieve.
const COLLISION_EPS = 1e-6;
const ADJACENCY_TOLERANCE = 0.03;
const EXTERIOR_TOLERANCE = 0.01;

// A living room bigger than its dataset-derived p90 size isn't necessarily
// broken - p90 is a statistical percentile describing typical real plans,
// not a hard architectural ceiling, so a plan sitting a little above it is
// still perfectly plausible. This multiplier gives it some headroom before
// the "oversized" check actually fails, so only a GENUINELY excessive
// living room (one that's swallowed space that should have gone
// elsewhere) gets flagged.
const OVERSIZE_TOLERANCE_MULTIPLIER = 1.15;

// ---------------------------------------------------------------------
// Geometry helpers (functionally identical to the ones in solver.js, with
// shorter comments here since the reasoning is explained in full over
// there - kept duplicated rather than imported so this file can be read in
// isolation without needing to cross-reference solver.js).
// ---------------------------------------------------------------------

function overlapArea(a, b) {
  const overlapWidth =
    Math.min(a.cx + a.w / 2, b.cx + b.w / 2) -
    Math.max(a.cx - a.w / 2, b.cx - b.w / 2);
  const overlapHeight =
    Math.min(a.cy + a.h / 2, b.cy + b.h / 2) -
    Math.max(a.cy - a.h / 2, b.cy - b.h / 2);
  if (overlapWidth <= 0 || overlapHeight <= 0) return 0;
  return overlapWidth * overlapHeight;
}

function gapBetween(a, b) {
  const dx = Math.max(0, Math.abs(a.cx - b.cx) - (a.w + b.w) / 2);
  const dy = Math.max(0, Math.abs(a.cy - b.cy) - (a.h + b.h) / 2);
  return Math.hypot(dx, dy);
}

// Is one particular SIDE of `box` (its top/bottom/left/right wall) touching
// the exterior? A wall counts as exterior if nothing else in the layout
// stands directly beyond it, sharing that wall's own span - see solver.js's
// isSideExterior for the full reasoning (there's no fixed plot boundary to
// check against, since plot size is only known after solving, so this
// "look straight out - is anything in the way" test stands in for one).
function isSideExterior(box, side, otherBoxes) {
  const boxLeft = box.cx - box.w / 2;
  const boxRight = box.cx + box.w / 2;
  const boxTop = box.cy - box.h / 2;
  const boxBottom = box.cy + box.h / 2;

  for (const other of otherBoxes) {
    const otherLeft = other.cx - other.w / 2;
    const otherRight = other.cx + other.w / 2;
    const otherTop = other.cy - other.h / 2;
    const otherBottom = other.cy + other.h / 2;

    if (side === "top" || side === "bottom") {
      const sharedSpan = Math.min(boxRight, otherRight) - Math.max(boxLeft, otherLeft);
      if (sharedSpan <= 0) continue;
      if (side === "top" && otherBottom <= boxTop + EXTERIOR_TOLERANCE) return false;
      if (side === "bottom" && otherTop >= boxBottom - EXTERIOR_TOLERANCE) return false;
    } else {
      const sharedSpan = Math.min(boxBottom, otherBottom) - Math.max(boxTop, otherTop);
      if (sharedSpan <= 0) continue;
      if (side === "left" && otherRight <= boxLeft + EXTERIOR_TOLERANCE) return false;
      if (side === "right" && otherLeft >= boxRight - EXTERIOR_TOLERANCE) return false;
    }
  }

  return true;
}

// A room counts as "on the exterior" if AT LEAST ONE of its four walls has
// nothing else standing directly beyond it (see isSideExterior above). It
// doesn't need open air on every side - just one true exterior wall, e.g.
// for a door opening or a balcony railing.
function isOnExterior(box, otherBoxes) {
  if (otherBoxes.length === 0) return true;
  return (
    isSideExterior(box, "top", otherBoxes) ||
    isSideExterior(box, "bottom", otherBoxes) ||
    isSideExterior(box, "left", otherBoxes) ||
    isSideExterior(box, "right", otherBoxes)
  );
}

/**
 * Run every usability check against a solved layout.
 *
 * @param {Array<{id: string, type: string, cx: number, cy: number, w: number, h: number}>} solvedRooms
 *   solveLayout()'s `rooms` output.
 * @param {Object<string, string>} attachMap - roomId -> targetRoomId, from
 *   buildAttachMap().
 * @returns {{ passed: boolean, checks: Object<string, boolean> }}
 */
export function validateLayout(solvedRooms, attachMap) {
  const checks = {};

  const byId = new Map(solvedRooms.map((room) => [room.id, room]));
  // Every OTHER room besides `room` itself - used for exterior checks,
  // where a room's own box must never be compared against a copy of itself.
  const others = (room) => solvedRooms.filter((r) => r.id !== room.id);

  // ---- 1. No overlaps ------------------------------------------------------
  // Two rooms occupying the same floor space is the single most basic way
  // a "floor plan" could be physically unbuildable - you cannot construct
  // two rooms on top of each other, no matter how good the rest of the
  // layout is.
  let noOverlaps = true;
  for (let i = 0; i < solvedRooms.length && noOverlaps; i++) {
    for (let j = i + 1; j < solvedRooms.length && noOverlaps; j++) {
      if (overlapArea(solvedRooms[i], solvedRooms[j]) > COLLISION_EPS) {
        noOverlaps = false;
      }
    }
  }
  checks.noOverlaps = noOverlaps;

  // A quick note on the checks below: each one uses Array.prototype.every()
  // over a filtered room list (e.g. "every front door", "every balcony").
  // JavaScript's .every() returns true for an EMPTY array by definition
  // ("all zero of these satisfy the condition" is vacuously true) - which
  // is exactly the behaviour we want here: a plan with, say, zero storage
  // rooms should not fail a storage-related check that simply doesn't
  // apply to it.

  // ---- 2. Front door touches an exterior edge ------------------------------
  // A front door buried in the middle of the plan, with rooms on every
  // side of it, isn't a usable entrance - there would be nowhere for it to
  // actually open onto the street.
  const frontDoors = solvedRooms.filter((room) => room.type === "front_door");
  checks.frontDoorOnExterior = frontDoors.every((fd) => isOnExterior(fd, others(fd)));

  // ---- 3. Front door is adjacent to living ---------------------------------
  // The entrance should open directly into the shared/public part of the
  // home, not require walking through some other room first just to reach
  // the door.
  checks.frontDoorNearLiving = frontDoors.every((fd) => {
    const targetId = attachMap[fd.id];
    const target = targetId ? byId.get(targetId) : undefined;
    return Boolean(target) && gapBetween(fd, target) <= ADJACENCY_TOLERANCE;
  });

  // ---- 4. Kitchen is adjacent to living -------------------------------------
  // A kitchen that ends up nowhere near the living space breaks the normal
  // cooking/serving/eating flow a home is expected to have.
  const kitchens = solvedRooms.filter((room) => room.type === "kitchen");
  checks.kitchenAdjacentToLiving = kitchens.every((kitchen) => {
    const targetId = attachMap[kitchen.id];
    const target = targetId ? byId.get(targetId) : undefined;
    return Boolean(target) && gapBetween(kitchen, target) <= ADJACENCY_TOLERANCE;
  });

  // ---- 5. Every balcony touches an exterior edge ----------------------------
  // A balcony needs open air to actually function as a balcony - one fully
  // enclosed by other rooms couldn't have a railing or a door leading
  // outside.
  const balconies = solvedRooms.filter((room) => room.type === "balcony");
  checks.balconiesOnExterior = balconies.every((balcony) => isOnExterior(balcony, others(balcony)));

  // ---- 6. Every bedroom<->bathroom attach pair is actually adjacent --------
  // Specifically checks the EN-SUITE pairings buildAttachMap.js created
  // (a bathroom attached to one SPECIFIC bedroom) - not the shared hall
  // bathrooms, which attach to living instead and are covered implicitly
  // by whatever general adjacency they need. An en-suite bathroom that
  // ended up far from its bedroom defeats the entire point of calling it
  // an en-suite.
  const bedroomIds = new Set(
    solvedRooms.filter((room) => room.type === "bedroom").map((room) => room.id)
  );
  const ensuiteBathrooms = solvedRooms.filter(
    (room) => room.type === "bathroom" && bedroomIds.has(attachMap[room.id])
  );
  checks.ensuiteBathroomsAdjacent = ensuiteBathrooms.every((bathroom) => {
    const bedroom = byId.get(attachMap[bathroom.id]);
    return Boolean(bedroom) && gapBetween(bathroom, bedroom) <= ADJACENCY_TOLERANCE;
  });

  // ---- 7. Living room isn't absurdly oversized ------------------------------
  // A living room many times bigger than anything in the real 17,000-plan
  // dataset ever had is a red flag that something in seeding/solving went
  // wrong (e.g. it ended up swallowing space that should have gone to
  // other rooms), not evidence of a deliberately generous design choice.
  const livingRooms = solvedRooms.filter((room) => room.type === "living");
  const totalBuiltArea = solvedRooms.reduce((sum, room) => sum + room.w * room.h, 0);
  const totalLivingArea = livingRooms.reduce((sum, room) => sum + room.w * room.h, 0);
  // SIZE_RANGES fractions are relative to TOTAL built area, so the check
  // has to recompute that same fraction from the actual solved geometry,
  // not just compare a raw area number to a raw fraction.
  const livingFraction = totalBuiltArea > 0 ? totalLivingArea / totalBuiltArea : 0;
  // SIZE_RANGES.living.max (p90) is living's share of TOTAL built area,
  // mined across real plans that average AVG_OTHER_ROOMS_PER_PLAN non-living
  // rooms each. Comparing that single flat fraction against every room
  // PROGRAM regardless of its own room count is comparing against the wrong
  // baseline for anything far from that average: neither seeding.js nor
  // solver.js ever resizes a room after it's first placed (every room is
  // always exactly its SIZE_RANGES[type].target fraction, fixed at seed
  // time), so a program with fewer "other" rooms than average will ALWAYS
  // show a higher living fraction than the dataset's typical-size plans did
  // - not because anything was placed wrong, but because there are fewer
  // other rooms sharing (and therefore diluting) the total. A studio/1BHK's
  // living room dominating its floor area is architecturally normal; a
  // family room dwarfing seven other rooms in an 8-room home would not be -
  // this check needs to tell those two situations apart instead of judging
  // both by the same fixed number.
  //
  // Model it the same way this pipeline actually builds a layout: living's
  // area is fixed (L, its own SIZE_RANGES target - never resized), and every
  // OTHER room's area is also roughly fixed on average (k), so a plan's
  // total built area is approximately L + k * (count of other rooms).
  // Solving datasetMaxFraction = L / (L + k * AVG_OTHER_ROOMS_PER_PLAN) for
  // k, then re-solving that same relationship for THIS program's own
  // other-room count, gives an expected max fraction that scales with room
  // count instead of staying flat: it loosens for small programs (fewer
  // other rooms -> living's natural share rises) and correctly TIGHTENS for
  // large ones (many other rooms -> a living room still eating the
  // dataset's "typical" share would actually be oversized).
  const otherRoomCount = Math.max(1, solvedRooms.length - livingRooms.length);
  const datasetMaxFraction = SIZE_RANGES.living.max;
  const otherRoomRatio = otherRoomCount / AVG_OTHER_ROOMS_PER_PLAN;
  const expectedMaxFraction = 1 / (1 + (1 / datasetMaxFraction - 1) * otherRoomRatio);
  checks.livingNotOversized =
    livingRooms.length === 0 ||
    livingFraction <= expectedMaxFraction * OVERSIZE_TOLERANCE_MULTIPLIER;

  // The layout passes overall only if every single check passed - one
  // failing check is enough to fail the whole plan, since each check
  // represents a genuine real-world usability problem on its own.
  const passed = Object.values(checks).every(Boolean);

  return { passed, checks };
}
