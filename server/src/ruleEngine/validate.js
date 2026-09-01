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
import { estimatePlotDimensions } from "./plotSizing.js";

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

// A real door needs a real, non-trivial stretch of shared wall to sit in -
// not just two boxes whose bounding-box GAP happens to be small. Two rooms
// can be "gapBetween-close" (see gapBetween below) while only touching at a
// near-zero-length corner, which isn't a wall they actually share. Mirrors
// doors.js's own MIN_SHARED_SPAN (0.30m - a standard minimum architectural
// door-wall span, not derived from this project's data) converted into
// THIS file's unit space via the same metersPerUnit factor the render
// layer uses, rather than importing doors.js's real-metre logic directly -
// this file's own convention throughout (see the geometry-helpers comment
// below) is to duplicate cross-file geometry rather than cross-import it,
// so it stays readable in isolation; see doors.js for the original figure
// this is kept consistent with.
const MIN_SHARED_SPAN_M = 0.30;

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

// Do `a` and `b` share a REAL wall - not just a close bounding-box gap, but
// an actual overlapping span along a shared edge, wide enough to plausibly
// hold a door? Unit-space equivalent of doors.js's sharedEdge: checks both
// possible pairings per axis (a's right against b's left, AND a's left
// against b's right; same for top/bottom), since this project's attach map
// doesn't record which side of which room is which. This is the check
// this milestone's whole reason for existing needed: gapBetween() alone
// (used by every OTHER adjacency check in this file) can't tell "genuinely
// sharing a wall" apart from "bounding boxes happen to be close" - that
// gap is exactly what let the balcony/en-suite-bathroom seeding collision
// (fixed in seeding.js this same pass) go undetected by this file
// entirely; nothing here ever checked balcony-to-target adjacency at all
// until this check was added.
function hasSharedWall(a, b, metersPerUnit) {
  const minSpan = MIN_SHARED_SPAN_M / metersPerUnit;
  const aLeft = a.cx - a.w / 2;
  const aRight = a.cx + a.w / 2;
  const aTop = a.cy - a.h / 2;
  const aBottom = a.cy + a.h / 2;
  const bLeft = b.cx - b.w / 2;
  const bRight = b.cx + b.w / 2;
  const bTop = b.cy - b.h / 2;
  const bBottom = b.cy + b.h / 2;

  for (const [xa, xb] of [
    [aRight, bLeft],
    [aLeft, bRight],
  ]) {
    const gap = Math.abs(xa - xb);
    const spanStart = Math.max(aTop, bTop);
    const spanEnd = Math.min(aBottom, bBottom);
    if (gap <= ADJACENCY_TOLERANCE && spanEnd - spanStart > minSpan) return true;
  }
  for (const [ya, yb] of [
    [aBottom, bTop],
    [aTop, bBottom],
  ]) {
    const gap = Math.abs(ya - yb);
    const spanStart = Math.max(aLeft, bLeft);
    const spanEnd = Math.min(aRight, bRight);
    if (gap <= ADJACENCY_TOLERANCE && spanEnd - spanStart > minSpan) return true;
  }
  return false;
}

// ---------------------------------------------------------------------
// General reachability graph (this pass - see check 8 below for the full
// story of why this replaced the old bedroom-only, single-hop version).
//
// Builds an UNDIRECTED graph over every room, where an edge between two
// rooms exists ONLY IF (a) attachMap actually records a relationship
// between them in either direction, AND (b) hasSharedWall confirms that
// relationship corresponds to a REAL, physical, door-sized shared wall -
// mirroring EXACTLY what doors.js's placeInteriorDoors does (it iterates
// attachMap's relationships and cuts a door only when its own sharedEdge
// check finds a genuine shared span; hasSharedWall here is this file's
// unit-space equivalent of that same geometric test). This is a
// deliberate, important choice, not an equivalent shortcut: a graph built
// from PURE geometry (any two rooms that happen to physically touch,
// attachMap or not) would have missed the exact defect this check exists
// to catch - the sealed-bathroom/sealed-storage bug this pass fixed had
// two rooms that DID physically touch (e.g. bathroom_1 touching
// bathroom_0), but attachMap never told doors.js to cut a door on that
// specific wall (it labelled bathroom_1's target as `living`, which it did
// NOT physically touch) - so no door ever existed there, even though the
// wall did. Restricting graph edges to attachMap relationships that ALSO
// pass hasSharedWall models "is there actually a door here", which is the
// real question this check needs to answer, not just "do these two rooms'
// boxes happen to be near each other".
//
// front_door's own relationship is excluded from the graph entirely - it's
// an exterior-wall opening, not an interior door between two habitable
// rooms (doors.js's placeInteriorDoors skips it for the same reason), so it
// shouldn't be treated as a pass-through connector for other rooms' own
// reachability.
function buildDoorReachabilityGraph(solvedRooms, attachMap, metersPerUnit) {
  const byId = new Map(solvedRooms.map((room) => [room.id, room]));
  const adjacency = new Map(solvedRooms.map((room) => [room.id, []]));

  for (const [srcId, targetId] of Object.entries(attachMap)) {
    const a = byId.get(srcId);
    const b = byId.get(targetId);
    if (!a || !b) continue;
    if (a.type === "front_door" || b.type === "front_door") continue;
    if (!hasSharedWall(a, b, metersPerUnit)) continue;
    adjacency.get(a.id).push(b.id);
    adjacency.get(b.id).push(a.id);
  }

  return adjacency;
}

// Plain breadth-first search: every room id reachable from any of `sources`
// by following the graph's edges, `sources` themselves included.
function bfsReachable(adjacency, sources) {
  const visited = new Set(sources);
  const queue = [...sources];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const neighbor of adjacency.get(current) ?? []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return visited;
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

  // estimatePlotDimensions() only ever reads each room's `.type`, never a
  // position, so re-deriving metersPerUnit here on the solved room list
  // reproduces the exact same factor solveLayout()/the render layer used
  // internally - same safe re-derivation pattern used throughout this
  // codebase (see wallNetwork.js's own comment on it). Needed by
  // hasSharedWall's real-metre MIN_SHARED_SPAN_M threshold below.
  const { metersPerUnit } = estimatePlotDimensions(solvedRooms);

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

  // ---- 8. Every room has a real, door-reachable path back to living --------
  // GENERALIZED this pass from a bedroom-only, single-hop check into a real
  // graph/BFS reachability check over every room type - see STATUS.md's Day
  // 7-8 reviewer close-out for the full story of why the narrower version
  // wasn't enough: it independently verified the ORIGINAL bedroom fix (an
  // automatic `hallway` room, every bedroom attached to it, the hallway
  // attached to living) held up completely, but then found a NEW,
  // considerably bigger problem the bedroom-only check had no way to catch
  // at all - 60.7% of a 672-combination sweep (408/672) produced at least
  // one room with literally zero doors anywhere (640 sealed-bathroom
  // instances, 168 sealed-storage instances), including the project's own
  // recurring 3-bed/2-bath demo scenario and an entirely ordinary 4-bed/
  // 2-bath request. Root cause (seeding.js's claimPosition, fixed this same
  // pass): when several same-type siblings share one attach target and fan
  // out past that target's own edge length, only the FIRST one genuinely
  // touches the target - every later one only touches the SIBLING beside
  // it, but attachMap.js kept labelling all of them "-> target" regardless,
  // so doors.js correctly found no real wall for the mislabelled ones and
  // cut no door at all. No check in this file ever looked at that (every
  // check above only verifies a room's relationship to ITS OWN nominal
  // attach target, one hop, never asking "but is there actually a
  // MULTI-hop path back to living through whatever it's really touching").
  //
  // This check verifies exactly that: build a graph whose edges are
  // attachMap relationships that ALSO pass hasSharedWall (i.e. relationships
  // doors.js would actually cut a real door for - see
  // buildDoorReachabilityGraph's own comment for why "real door", not just
  // "physically touches", is the right standard here), then BFS from every
  // living room and confirm every OTHER room - except hallway and
  // front_door, which have their own dedicated checks/roles rather than
  // needing to independently reach living themselves - shows up as
  // reachable. Chained, multi-hop paths (bedroom -> hallway -> living;
  // bathroom_2 -> bathroom_1 -> bathroom_0 -> living, once seeding.js's
  // fix resolves that chain into the attach map) are exactly what BFS is
  // for, not a special case - this is the "not a shortcut that only checks
  // one hop" requirement this pass was asked to satisfy.
  const livingRoomIds = solvedRooms
    .filter((room) => room.type === "living")
    .map((room) => room.id);
  const reachabilityGraph = buildDoorReachabilityGraph(solvedRooms, attachMap, metersPerUnit);
  const reachableFromLiving = bfsReachable(reachabilityGraph, livingRoomIds);
  const roomsNeedingReachability = solvedRooms.filter(
    (room) => room.type !== "living" && room.type !== "hallway" && room.type !== "front_door"
  );
  checks.everyRoomReachableFromLiving =
    livingRoomIds.length > 0 &&
    roomsNeedingReachability.every((room) => reachableFromLiving.has(room.id));

  // The layout passes overall only if every single check passed - one
  // failing check is enough to fail the whole plan, since each check
  // represents a genuine real-world usability problem on its own.
  const passed = Object.values(checks).every(Boolean);

  return { passed, checks };
}
