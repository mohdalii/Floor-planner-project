// solver.js
//
// The minimum-movement refinement loop. Takes the rough, possibly-overlapping
// layout seeding.js produced and nudges rooms around until collisions are
// gone and every attach/exterior relationship from attachMap.js is
// satisfied - while moving as FEW rooms, and as little, as possible.
//
// Conceptually ported from the earlier hybrid project's iterative
// priority-tiered solver (`_layout_solver.py` - see docs/PLAN.md), but
// written fresh here for plain JS room objects instead of PyTorch tensors,
// and working from a rule-based seed (seeding.js) instead of a trained
// model's prediction, since this project has no model.
//
// -----------------------------------------------------------------------
// The algorithm, in plain language:
//
// 1. Walk every room once, in PRIORITY order (highest first - see
//    constants.js), highest-priority rooms settle first and are re-checked
//    least often relative to lower ones. Ties (two rooms of the same type,
//    e.g. two bedrooms) are broken by the room's position in the input
//    array, i.e. its declaration order.
// 2. For each room, first ask: does it actually have a PROBLEM? (an
//    overlap with another room of EQUAL OR HIGHER priority, or an
//    attach/exterior relationship from attachMap.js that isn't satisfied
//    within a small tolerance). If not, LEAVE IT ALONE. This is the
//    "minimal movement" principle this whole solver is built around: a
//    room that's already fine architecturally should never be shuffled
//    around just because some other position might theoretically look
//    nicer. Only rooms with a genuine problem are ever considered for a
//    move.
//    Overlapping with something of STRICTLY LOWER priority does not, on
//    its own, count as this room's problem - it's the less important
//    room's job to get out of the way, not the more important one's job to
//    flee. Without this rule, a high-priority room could get dragged out
//    of position purely because a low-priority room happened to still be
//    sitting in its seeded (not-yet-resolved) spot earlier in the very
//    same pass - exactly the kind of unnecessary movement this solver is
//    meant to avoid. (Two rooms of the SAME priority, e.g. two bedrooms,
//    both treat each other as relevant, so either may move.)
// 3. If a room does have a problem, generate a handful of candidate new
//    positions for it (nudge toward its attach target, nudge away from
//    whatever it's colliding with worst, and a few plain cardinal nudges),
//    and score each candidate with a LEXICOGRAPHIC cost - compare tier 1
//    first, and only use tier 2 to break ties within tier 1, and so on:
//      (1) collision severity  - total overlap area with every other room
//                                  of EQUAL OR HIGHER priority (the same
//                                  "not my problem" rule from step 2 above
//                                  also applies here, so a candidate is
//                                  never scored as if fleeing a low-priority
//                                  room were something worth doing)
//                                  (lower is better; 0 = no collisions at all)
//      (2) relationship         - gap to its attach target, plus a penalty
//                                  if it's a balcony/front_door that isn't
//                                  touching an exterior edge (lower is
//                                  better; 0 = perfectly satisfied)
//      (3) stability             - distance moved from its ORIGINAL SEEDED
//                                  position (lower is better). This is the
//                                  direct replacement for the earlier
//                                  project's "distance from the ML model's
//                                  prediction" term - there's no model here
//                                  to stay close to, so we stay close to the
//                                  rule-based seed instead. This keeps
//                                  results deterministic (same input always
//                                  produces the same output) and stops the
//                                  solver from wandering arbitrarily far
//                                  just to shave a tiny amount off a higher
//                                  tier.
//    Whichever candidate wins the lexicographic comparison becomes the
//    room's new position for the rest of this pass.
// 4. Repeat step 1-3 for up to `maxIterations` full passes, but stop early
//    the moment a full pass makes zero changes - the layout has converged
//    and further passes would just repeat the same no-op work.
// 5. Run one final "collision safety net" pass: for any pair of rooms still
//    overlapping after the priority-ordered relaxation above (this can
//    happen if two low-priority rooms only ever collide with EACH OTHER
//    and neither one's turn in step 1-3 happened to fully resolve it),
//    nudge them apart directly. Whichever of the two has the LOWER
//    PRIORITY is the one that moves - the more architecturally important
//    room (e.g. a bedroom over a storage room) is left exactly where it
//    settled.
// 6. Finally, measure the solved layout's bounding box and convert it to
//    real metres using plotSizing.js's metersPerUnit factor. This is where
//    "dynamic plot sizing" actually resolves to concrete numbers - the
//    plot's real width/depth is a MEASUREMENT of the finished layout, not
//    something decided in advance.
// -----------------------------------------------------------------------

import { PRIORITY } from "./constants.js";
import { estimatePlotDimensions } from "./plotSizing.js";

// Room types that architecturally MUST reach outside air - a balcony
// without open air on at least one side isn't a balcony, and a front door
// that isn't on an exterior edge can't open onto the street.
const REQUIRES_EXTERIOR = new Set(["balcony", "front_door"]);

// Below this overlap area (in unit^2), two rooms are treated as "not
// actually colliding" - this is just a floating-point safety margin, not a
// real architectural tolerance (room areas here are on the order of
// 0.01-0.4 unit^2, so 1e-6 is effectively zero by comparison).
const COLLISION_EPS = 1e-6;

// How much gap (in unit-space distance) between a room and its attach
// target still counts as "adjacent enough". Deliberately a bit larger than
// seeding.js's SEED_GAP (0.02), so rooms seeded directly next to their
// target are already considered satisfied and never get moved purely to
// close a gap that was already architecturally fine.
const ADJACENCY_TOLERANCE = 0.03;

// How close a room's own edge has to be to the outermost edge of every
// OTHER room in the layout to count as "on the exterior" (see isOnExterior
// below) - a small floating-point margin, not a real wall-thickness value.
const EXTERIOR_TOLERANCE = 0.01;

// A flat penalty added to a candidate's "relationship" cost tier when it's
// an exterior-requiring room (balcony/front_door) that ISN'T on an
// exterior edge. Chosen to be comfortably larger than any realistic
// attach-gap distance in this unit space (every room here has a side
// length well under 1 unit), so failing the exterior requirement always
// outweighs a small difference in attach-target gap within the same tier -
// exactly the "hard requirement beats soft preference" behaviour this tier
// is meant to express.
const EXTERIOR_PENALTY = 10;

// How far (as a fraction of a room's own largest dimension) a single nudge
// moves it. A quarter of the room's own size is small enough that several
// nudges are usually needed to fully resolve a bad overlap (keeping
// movement gradual and traceable) but large enough that the solver
// converges in a reasonable number of passes rather than crawling.
const NUDGE_FRACTION = 0.25;

// A hard cap on the collision safety-net's own pass count (step 5 above),
// completely separate from the caller's maxIterations. It only exists to
// clean up leftover pairwise overlaps, so it doesn't need nearly as many
// passes as the main relaxation loop - this is just a guard against a
// pathological case looping forever.
const SAFETY_MAX_PASSES = 20;

// ===========================================================================
// Geometry helpers
//
// These operate on plain {cx, cy, w, h} boxes (axis-aligned rectangles
// described by their center point and full width/height). They're the only
// place in this file that does actual coordinate arithmetic - everything
// else works in terms of these.
// ===========================================================================

// How much area two axis-aligned rectangles overlap by. Returns 0 (not
// negative) when they don't overlap at all on either axis.
function overlapArea(a, b) {
  // The overlap on one axis is however far the two rectangles' near edges
  // are from each other's far edges - i.e. take the smaller of their two
  // "far" edges and subtract the larger of their two "near" edges. If that
  // comes out <= 0, they don't overlap on that axis at all, and two
  // rectangles only truly overlap if they overlap on BOTH axes at once.
  const overlapWidth =
    Math.min(a.cx + a.w / 2, b.cx + b.w / 2) -
    Math.max(a.cx - a.w / 2, b.cx - b.w / 2);
  const overlapHeight =
    Math.min(a.cy + a.h / 2, b.cy + b.h / 2) -
    Math.max(a.cy - a.h / 2, b.cy - b.h / 2);
  if (overlapWidth <= 0 || overlapHeight <= 0) return 0;
  return overlapWidth * overlapHeight;
}

// The shortest edge-to-edge distance between two axis-aligned rectangles.
// Returns 0 if they're touching or overlapping (never negative).
function gapBetween(a, b) {
  // On each axis, the gap is how far apart the two centers are, minus how
  // much of that distance is "used up" by each box's own half-width (or
  // half-height). Clamped to 0, because a negative value here just means
  // the boxes overlap on that axis, which reads as "0 gap on this axis".
  const dx = Math.max(0, Math.abs(a.cx - b.cx) - (a.w + b.w) / 2);
  const dy = Math.max(0, Math.abs(a.cy - b.cy) - (a.h + b.h) / 2);
  // Combine the two axis gaps into one straight-line distance. If the
  // boxes are offset on only one axis (aligned on the other), this
  // correctly reduces to a simple gap along that one axis.
  return Math.hypot(dx, dy);
}

// The smallest axis-aligned rectangle that contains every box in `boxes`.
function computeBoundingBox(boxes) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    minX = Math.min(minX, box.cx - box.w / 2);
    maxX = Math.max(maxX, box.cx + box.w / 2);
    minY = Math.min(minY, box.cy - box.h / 2);
    maxY = Math.max(maxY, box.cy + box.h / 2);
  }
  return { minX, maxX, minY, maxY };
}

// Is one particular SIDE of `box` (its top/bottom/left/right wall) touching
// the exterior? A wall counts as exterior if nothing else in the layout
// stands directly beyond it - if you stood at that wall and looked
// straight out across only the stretch the wall itself spans, nothing else
// in `otherBoxes` would be in the way.
//
// Only rooms that actually share part of that wall's span are even
// candidates for blocking it: something off to the side, past either end
// of the wall, could never be "in front of" it no matter how far out it
// sits. That's the `sharedSpan <= 0 -> continue` check below for each
// candidate blocker.
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
      // A room can only stand in front of a top/bottom wall if it shares
      // some of that wall's horizontal (x) span.
      const sharedSpan = Math.min(boxRight, otherRight) - Math.max(boxLeft, otherLeft);
      if (sharedSpan <= 0) continue;
      // "top" faces toward smaller y (the plot's front) - blocked by
      // anything whose bottom edge reaches at least as far toward the
      // front as box's own top edge does.
      if (side === "top" && otherBottom <= boxTop + EXTERIOR_TOLERANCE) return false;
      // "bottom" faces toward larger y (the plot's back) - blocked by
      // anything whose top edge reaches at least as far back.
      if (side === "bottom" && otherTop >= boxBottom - EXTERIOR_TOLERANCE) return false;
    } else {
      // left/right: only a room sharing some of the wall's vertical (y)
      // span could possibly block it.
      const sharedSpan = Math.min(boxBottom, otherBottom) - Math.max(boxTop, otherTop);
      if (sharedSpan <= 0) continue;
      if (side === "left" && otherRight <= boxLeft + EXTERIOR_TOLERANCE) return false;
      if (side === "right" && otherLeft >= boxRight - EXTERIOR_TOLERANCE) return false;
    }
  }

  return true; // nothing found sharing this wall's span AND standing beyond it
}

// Is `box` on the "exterior" at all - i.e. does AT LEAST ONE of its four
// walls have nothing beyond it (see isSideExterior above)? A room only
// needs one true exterior wall to be valid (a balcony's door, a front
// door's opening, ...) - it doesn't need to be surrounded by open air on
// every side.
//
// There's no fixed plot boundary anywhere in this project - the plot's
// real size is only measured AFTER solving (see the end of solveLayout
// below), so "exterior" can't mean "touches a pre-drawn wall". This
// per-side shadow test is the substitute: it only compares a room against
// whatever ELSE actually shares that specific wall's footprint, rather
// than against the layout's single overall bounding box - which matters
// because two different exterior-requiring rooms (say, the front door and
// a balcony) can both legitimately have their own true exterior wall on
// the same general side of the house, as long as neither is standing
// directly in front of the other.
function isOnExterior(box, otherBoxes) {
  if (otherBoxes.length === 0) return true; // only room in the layout - every wall is exterior
  return (
    isSideExterior(box, "top", otherBoxes) ||
    isSideExterior(box, "bottom", otherBoxes) ||
    isSideExterior(box, "left", otherBoxes) ||
    isSideExterior(box, "right", otherBoxes)
  );
}

// Moves `box` one `step` toward `targetBox`'s center. Used to close an
// attach-relationship gap.
function moveToward(box, targetBox, step) {
  const dx = targetBox.cx - box.cx;
  const dy = targetBox.cy - box.cy;
  const distance = Math.hypot(dx, dy);
  if (distance < 1e-9) return box; // already centered on the target - no direction to move in
  // Normalize (dx, dy) into a unit vector, then scale it up to length
  // `step` - this is the standard way to say "move this far, in this
  // direction" from a raw direction vector.
  const ux = dx / distance;
  const uy = dy / distance;
  return { ...box, cx: box.cx + ux * step, cy: box.cy + uy * step };
}

// Moves `box` one `step` away from `otherBox`'s center. Used to back a room
// off of whatever it's colliding with worst.
function moveAway(box, otherBox, step) {
  const dx = box.cx - otherBox.cx;
  const dy = box.cy - otherBox.cy;
  const distance = Math.hypot(dx, dy);
  let ux;
  let uy;
  if (distance < 1e-9) {
    // The two boxes are centered on exactly the same point (e.g. two rooms
    // seeded on top of each other) - there's no natural "away" direction,
    // so break the tie deterministically by picking +x. Any fixed choice
    // works here; what matters is that it's always the SAME choice, so the
    // solver stays deterministic.
    ux = 1;
    uy = 0;
  } else {
    ux = dx / distance;
    uy = dy / distance;
  }
  return { ...box, cx: box.cx + ux * step, cy: box.cy + uy * step };
}

// ===========================================================================
// Problem detection and candidate scoring
// ===========================================================================

// Whether a collision with a room of `otherType` counts as a `selfType`
// room's OWN problem to fix by moving. A room only reacts to colliders of
// EQUAL OR HIGHER priority - colliding with something strictly less
// architecturally important than itself is the OTHER room's problem to
// solve, not this one's. This mirrors the exact same reasoning
// runCollisionSafetyNet (below) uses explicitly when it decides which of
// two overlapping rooms to nudge: the more important room holds its
// ground, the less important one yields. Applying that rule HERE too (not
// just in the safety net) is what stops a high-priority room from ever
// being dragged out of position simply because a lower-priority room
// hadn't had its own turn yet this pass. Two rooms of the SAME priority
// (e.g. two bedrooms) both treat each other as relevant, since neither one
// architecturally outranks the other.
function isRelevantCollider(selfType, otherType) {
  return (PRIORITY[otherType] ?? 0) >= (PRIORITY[selfType] ?? 0);
}

// Does `box` have any problem that would justify moving it? Checked in the
// same three ways the cost function scores candidates, just as yes/no
// questions instead of a numeric severity.
function hasProblem(box, working, attachMap) {
  // 1. Colliding with anything of equal-or-higher priority?
  for (const other of working.values()) {
    if (other.id === box.id) continue;
    if (!isRelevantCollider(box.type, other.type)) continue;
    if (overlapArea(box, other) > COLLISION_EPS) return true;
  }

  // 2. Too far from its attach target (if it has one)?
  const targetId = attachMap[box.id];
  if (targetId) {
    const targetBox = working.get(targetId);
    if (targetBox && gapBetween(box, targetBox) > ADJACENCY_TOLERANCE) return true;
  }

  // 3. Requires an exterior edge but doesn't have one?
  if (REQUIRES_EXTERIOR.has(box.type)) {
    const others = [...working.values()].filter((r) => r.id !== box.id);
    if (!isOnExterior(box, others)) return true;
  }

  return false;
}

// Finds whichever OTHER room of equal-or-higher priority currently overlaps
// `box` the most, so a candidate can specifically move away from the worst
// RELEVANT offender rather than an arbitrary (possibly lower-priority, and
// therefore not this room's problem) one. Returns null if there's no
// meaningful relevant overlap at all.
function findWorstCollider(box, working) {
  let worst = null;
  let worstArea = 0;
  for (const other of working.values()) {
    if (other.id === box.id) continue;
    if (!isRelevantCollider(box.type, other.type)) continue;
    const area = overlapArea(box, other);
    if (area > worstArea) {
      worstArea = area;
      worst = other;
    }
  }
  return worstArea > COLLISION_EPS ? worst : null;
}

// Builds the small set of candidate positions to evaluate for a room with a
// problem. Deliberately a SHORT list ("a small number of reasonable
// candidates", not an exhaustive search) - this solver is meant to be
// simple and explainable, not a general-purpose optimizer.
function generateCandidates(box, working, attachMap, step) {
  // Always include the room's CURRENT position as one of the candidates.
  // This guarantees the solver can never make a room's situation actively
  // worse than doing nothing - if every alternative scores worse than
  // staying put, staying put is exactly what gets picked.
  const candidates = [box];

  // Candidate: a step toward the attach target, to help close a
  // relationship gap.
  const targetId = attachMap[box.id];
  if (targetId) {
    const targetBox = working.get(targetId);
    if (targetBox) candidates.push(moveToward(box, targetBox, step));
  }

  // Candidate: a step away from whichever room it overlaps worst, to help
  // resolve a collision.
  const worstCollider = findWorstCollider(box, working);
  if (worstCollider) candidates.push(moveAway(box, worstCollider, step));

  // A handful of plain cardinal nudges (up/down/left/right). These give an
  // exterior-requiring room (balcony/front_door) a way to reach a boundary
  // edge even when it has no collision or attach-target reaction to lean
  // on, and act as a general-purpose fallback candidate set for any other
  // situation the two cases above don't cover.
  candidates.push({ ...box, cx: box.cx + step, cy: box.cy });
  candidates.push({ ...box, cx: box.cx - step, cy: box.cy });
  candidates.push({ ...box, cx: box.cx, cy: box.cy + step });
  candidates.push({ ...box, cx: box.cx, cy: box.cy - step });

  return candidates;
}

// Scores one candidate position for `candidateBox.id` as a 3-element
// lexicographic cost tuple: [collision, relationship, stability]. Lower is
// better in every slot - see the big comment at the top of this file for
// what each tier means and why they're ordered this way.
function candidateCost(candidateBox, working, attachMap, seedPosition) {
  // Tier 1: collision severity - total overlap area against every OTHER
  // room of EQUAL OR HIGHER priority (see isRelevantCollider above),
  // evaluated as if this candidate were this room's real position.
  // Excluding lower-priority colliders here, not just in hasProblem, keeps
  // the two consistent: without this, a candidate that "solves" its
  // problem only by fleeing a low-priority room it was never supposed to
  // react to could still look like the best-scoring option purely by
  // accident, which would undermine the whole point of ignoring that
  // collision in the first place.
  let collision = 0;
  for (const other of working.values()) {
    if (other.id === candidateBox.id) continue;
    if (!isRelevantCollider(candidateBox.type, other.type)) continue;
    collision += overlapArea(candidateBox, other);
  }

  // Tier 2: relationship satisfaction - gap to the attach target (0 is
  // perfect), plus a large flat penalty if this room type requires an
  // exterior edge and this candidate doesn't have one.
  let relationship = 0;
  const targetId = attachMap[candidateBox.id];
  if (targetId) {
    const targetBox = working.get(targetId);
    if (targetBox) relationship += gapBetween(candidateBox, targetBox);
  }
  if (REQUIRES_EXTERIOR.has(candidateBox.type)) {
    const others = [...working.values()].filter((r) => r.id !== candidateBox.id);
    if (!isOnExterior(candidateBox, others)) relationship += EXTERIOR_PENALTY;
  }

  // Tier 3: stability - straight-line distance from where this room was
  // originally SEEDED (not from its current position - always the same
  // fixed reference point, so this term consistently favours whichever
  // candidate stays closest to the rule-based starting guess, no matter
  // how many times this room has already moved this run).
  const stability = Math.hypot(
    candidateBox.cx - seedPosition.cx,
    candidateBox.cy - seedPosition.cy
  );

  return [collision, relationship, stability];
}

// Lexicographic comparison of two cost tuples: compare index 0 first, and
// only fall through to index 1 (then 2) if index 0 is exactly equal. This
// is what makes the cost "lexicographic" rather than a single blended
// number - a candidate can never win by trading a worse collision score for
// a better relationship/stability score, only by tying on every tier before it.
function compareCostTuples(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// ===========================================================================
// Collision safety net (step 5 in the algorithm summary at the top)
// ===========================================================================

// Sweeps every pair of rooms and nudges apart any pair still overlapping
// after the main priority-ordered relaxation loop has finished. This can
// legitimately still find overlaps: the main loop only ever looks at ONE
// room's candidates at a time, so it's possible for two low-priority rooms
// to keep colliding with each other without either one's individual "best
// candidate" fully resolving it. This pass exists specifically to clean up
// that leftover case.
function runCollisionSafetyNet(working) {
  const ids = [...working.keys()];

  for (let pass = 0; pass < SAFETY_MAX_PASSES; pass++) {
    let anyOverlap = false;

    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = working.get(ids[i]);
        const b = working.get(ids[j]);
        if (overlapArea(a, b) <= COLLISION_EPS) continue;

        anyOverlap = true;

        // Move whichever room is architecturally LESS important (lower
        // PRIORITY) - the more important room (e.g. a bedroom over a
        // storage room) stays exactly where the main loop settled it.
        // Equal-priority ties (e.g. two bedrooms) are broken by comparing
        // ids, so the outcome is always the same for the same input rather
        // than depending on iteration order.
        const priorityA = PRIORITY[a.type] ?? 0;
        const priorityB = PRIORITY[b.type] ?? 0;
        let mover;
        let stationary;
        if (priorityA !== priorityB) {
          [mover, stationary] = priorityA < priorityB ? [a, b] : [b, a];
        } else {
          [mover, stationary] = a.id > b.id ? [a, b] : [b, a];
        }

        const step = Math.max(mover.w, mover.h) * NUDGE_FRACTION;
        const moved = moveAway(mover, stationary, step);
        working.set(mover.id, { ...mover, cx: moved.cx, cy: moved.cy });
      }
    }

    if (!anyOverlap) break; // nothing left to clean up
  }
}

// ===========================================================================
// Main entry point
// ===========================================================================

/**
 * Refine a seeded layout into one with no collisions and every
 * attach/exterior relationship satisfied, moving as little as possible.
 *
 * @param {Array<{id: string, type: string, cx: number, cy: number, w: number, h: number}>} seededRooms
 *   the output of seedLayout().
 * @param {Object<string, string>} attachMap - roomId -> targetRoomId, from
 *   buildAttachMap().
 * @param {{ maxIterations?: number }} [options]
 * @returns {{
 *   rooms: Array<{id: string, type: string, cx: number, cy: number, w: number, h: number}>,
 *   plot: { widthM: number, depthM: number, areaM2: number }
 * }}
 */
export function solveLayout(seededRooms, attachMap, { maxIterations = 70 } = {}) {
  // Working copy of every room's box, keyed by id. We never mutate the
  // caller's seededRooms array/objects directly - each update below
  // creates a fresh object via spread ({...box, cx, cy}) and stores it back
  // into this map instead.
  const working = new Map(seededRooms.map((room) => [room.id, { ...room }]));

  // Each room's ORIGINAL seeded position, frozen at the start and never
  // updated again - this is the fixed reference point the "stability" cost
  // tier measures distance from (see candidateCost above).
  const seedPositions = new Map(
    seededRooms.map((room) => [room.id, { cx: room.cx, cy: room.cy }])
  );

  // The order rooms get examined in, every pass: highest PRIORITY first,
  // ties broken by each room's position in the input array (its declared
  // order - seedLayout() guarantees seededRooms preserves the original
  // room-program order, so this index is a stable, meaningful tie-break).
  const processingOrder = seededRooms
    .map((room, index) => ({ id: room.id, type: room.type, index }))
    .sort((a, b) => {
      const priorityDiff = (PRIORITY[b.type] ?? 0) - (PRIORITY[a.type] ?? 0);
      if (priorityDiff !== 0) return priorityDiff;
      return a.index - b.index;
    })
    .map((entry) => entry.id);

  // ---- Priority-ordered relaxation passes ----------------------------------
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let changedThisPass = false;

    for (const roomId of processingOrder) {
      const box = working.get(roomId);

      // Minimal-movement principle: skip this room entirely unless it
      // actually has a problem right now. A room with nothing wrong with
      // it is never touched, no matter how many other rooms move around it.
      if (!hasProblem(box, working, attachMap)) continue;

      // Step size scales with the room's own size, so a tiny front door
      // takes tiny steps and a large living room takes proportionally
      // larger ones.
      const step = Math.max(box.w, box.h) * NUDGE_FRACTION;
      const candidates = generateCandidates(box, working, attachMap, step);

      // Evaluate every candidate and keep whichever wins the lexicographic
      // comparison. candidates[0] is always the room's current position,
      // so `best` starts there and only changes if something genuinely
      // scores better.
      let best = candidates[0];
      let bestCost = candidateCost(best, working, attachMap, seedPositions.get(roomId));
      for (let i = 1; i < candidates.length; i++) {
        const candidate = candidates[i];
        const cost = candidateCost(candidate, working, attachMap, seedPositions.get(roomId));
        if (compareCostTuples(cost, bestCost) < 0) {
          best = candidate;
          bestCost = cost;
        }
      }

      // Only actually update the room if the winning candidate is not
      // simply "stay put" (compared by reference, since candidates[0] IS
      // the same object as `box` when nothing beat it).
      if (best !== box) {
        // This update is applied IMMEDIATELY (not batched to the end of
        // the pass), so later rooms examined in this same pass see the
        // freshest positions - including rooms that were already updated
        // earlier in this same pass. This sequential ("settle as you go")
        // style is what lets a lower-priority room react correctly to a
        // higher-priority room that just moved moments ago in the same
        // pass, rather than reacting to stale, one-pass-old information.
        working.set(roomId, { ...box, cx: best.cx, cy: best.cy });
        changedThisPass = true;
      }
    }

    // Nothing moved in a full pass -> the layout has converged. Stop early
    // rather than burning through the rest of maxIterations doing nothing.
    if (!changedThisPass) break;
  }

  // ---- Collision safety net -------------------------------------------------
  runCollisionSafetyNet(working);

  // ---- Resolve the plot's real-world size from the finished layout ---------
  // Preserve the original declared order in the output, same as
  // seedLayout()'s contract.
  const finalRooms = seededRooms.map((room) => working.get(room.id));

  // estimatePlotDimensions only needs each room's `.type`, so the ORIGINAL
  // seeded list (or the final one - same set of rooms either way) works
  // fine here; nothing about the actual solved positions affects
  // metersPerUnit itself.
  const { metersPerUnit } = estimatePlotDimensions(seededRooms);

  // Measure the ACTUAL extent of the solved layout and convert it to real
  // metres. This is the point where "dynamic plot sizing" stops being an
  // abstract nominal estimate and becomes a concrete measurement of the
  // layout the solver actually produced.
  const bounds = computeBoundingBox(finalRooms);
  const widthM = (bounds.maxX - bounds.minX) * metersPerUnit;
  const depthM = (bounds.maxY - bounds.minY) * metersPerUnit;

  return {
    rooms: finalRooms.map(({ id, type, cx, cy, w, h }) => ({ id, type, cx, cy, w, h })),
    plot: { widthM, depthM, areaM2: widthM * depthM },
  };
}
