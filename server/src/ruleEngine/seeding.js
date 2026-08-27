// seeding.js
//
// THIS FILE IS THE NEW PIECE this project needed that the earlier hybrid
// project never had to write. That project's solver only ever REFINED a
// rough layout a trained geometry model had already produced - it never
// had to invent a first layout from scratch, because the model always
// handed it a starting point. This project has no model, so something has
// to generate that first rough guess, and that job belongs entirely to
// this file.
//
// seedLayout() places every room using simple, deterministic "put it near
// where it obviously belongs" rules: a public living zone at the front of
// the plot, a private bedroom zone directly behind it, and everything else
// clustered next to whatever it's supposed to attach to (from attachMap.js).
// It does NOT try to avoid overlaps, and does NOT try to produce an
// elegant/efficient layout - that refinement work is solver.js's job.
// Think of this as an architect's very first back-of-envelope sketch on a
// napkin, not a finished plan: rough, fast, and only meant to be a
// reasonable starting point for the real solving to correct.
//
// Units: everything here is in the rule engine's normalised "unit" space -
// the same space SIZE_RANGES areas are fractions of (a nominal plot of area
// 1 unit^2). Real-world metres only enter the picture at the very end of
// solveLayout() in solver.js, via plotSizing.js's metersPerUnit conversion
// factor - this file never needs to know how big a metre is.
//
// Coordinate convention (used consistently by seeding.js AND solver.js):
//   x - horizontal, left(-) to right(+).
//   y - depth, front(0) to back(+) of the plot. y = 0 is the plot's FRONT
//       edge - the street-facing side, where the front door belongs.
//   (cx, cy) - a room box's CENTER point. w/h - its extent along x/y (h is
//       the room's extent in the floor-plan PLANE, not a ceiling height).

import { PRIORITY, SIZE_RANGES } from "./constants.js";

// Small fixed gap left between adjacent rooms during seeding, purely so the
// initial guess doesn't start with every room's edges exactly touching (a
// gap of exactly 0 is indistinguishable from "just barely overlapping" once
// floating-point arithmetic gets involved). This is NOT a real wall
// thickness value - it just needs to be comfortably smaller than the
// ADJACENCY_TOLERANCE solver.js and validate.js use to decide "close enough
// to count as attached", so that rooms seeded next to their attach target
// already satisfy that relationship without solver.js needing to move them
// (the "minimal movement" principle starts paying off right from the seed).
const SEED_GAP = 0.02;

/**
 * Produce an initial (rough, NOT collision-free) placement for every room.
 *
 * @param {Array<{id: string, type: string, typeIndex: number}>} rooms - the
 *   flat room list from buildRoomProgram().
 * @param {Object<string, string>} attachMap - roomId -> targetRoomId, from
 *   buildAttachMap().
 * @returns {Array<{id: string, type: string, cx: number, cy: number, w: number, h: number}>}
 *   one box per input room, IN THE SAME ORDER as the `rooms` input - so
 *   later stages (solver.js) get a stable "declared order" to use as a
 *   tie-break without needing to know anything about how buildRoomProgram
 *   built the list in the first place.
 */
export function seedLayout(rooms, attachMap) {
  // Every room type gets a plain SQUARE starting size, whose area equals
  // SIZE_RANGES[type].target - the median real-world size for that type
  // across the 17,000-plan dataset. A square is obviously not the final
  // shape most real rooms end up as, but it's a simple, defensible starting
  // guess: side = sqrt(area) is just the definition of a square's side
  // length given its area, and nothing later in this file changes w/h
  // independently, so "square" is an honest description of what gets
  // placed, not a shape solver.js is expected to have already corrected.
  const sizeOf = (type) => {
    const targetArea = SIZE_RANGES[type].target;
    const side = Math.sqrt(targetArea);
    return { w: side, h: side };
  };

  // Rooms actually placed so far, keyed by id, so later rooms in the
  // priority order can look up where their attach-target ended up.
  const placed = new Map();

  // Multiple rooms can attach to the SAME target (e.g. two shared hall
  // bathrooms both attaching to living). attachStackIndex hands out an
  // increasing "slot number" per (target, role) pair so repeated
  // placements fan out along the target's edge instead of landing on top
  // of each other. The key includes a role suffix (":kitchen", ":storage",
  // ...) so, for example, bathrooms and kitchens attaching to the same
  // living room get independent counters rather than sharing one - they're
  // placed on different sides of living anyway (see placeAdjacent calls
  // below), so there's no reason for one role's count to push the other's
  // slot number up.
  const attachStackIndex = new Map();
  const nextStackIndex = (key) => {
    const index = attachStackIndex.get(key) ?? 0;
    attachStackIndex.set(key, index + 1);
    return index;
  };

  // Computes a position for `size` immediately next to `target`'s box, on
  // the given side, offset along the perpendicular axis by `stackIndex`
  // slots so repeated placements against the same target fan out rather
  // than stack exactly on top of each other.
  const placeAdjacent = (target, size, side, stackIndex) => {
    switch (side) {
      case "right":
        return {
          cx: target.cx + target.w / 2 + SEED_GAP + size.w / 2,
          cy: target.cy + stackIndex * (size.h + SEED_GAP),
        };
      case "left":
        return {
          cx: target.cx - target.w / 2 - SEED_GAP - size.w / 2,
          cy: target.cy + stackIndex * (size.h + SEED_GAP),
        };
      case "back": // further from the plot's front edge (larger y)
        return {
          cx: target.cx + stackIndex * (size.w + SEED_GAP),
          cy: target.cy + target.h / 2 + SEED_GAP + size.h / 2,
        };
      case "front": // toward the plot's front edge (smaller y)
        return {
          cx: target.cx + stackIndex * (size.w + SEED_GAP),
          cy: target.cy - target.h / 2 - SEED_GAP - size.h / 2,
        };
      default:
        throw new Error(`seedLayout: placeAdjacent got unknown side "${side}"`);
    }
  };

  // Group the input rooms by type once, sorted by typeIndex (declaration
  // order within a type) - buildAttachMap.js uses this same ordering, e.g.
  // for deciding "which bedroom is master".
  const byType = {};
  for (const room of rooms) {
    if (!byType[room.type]) byType[room.type] = [];
    byType[room.type].push(room);
  }
  for (const list of Object.values(byType)) {
    list.sort((a, b) => a.typeIndex - b.typeIndex);
  }

  // The blocks below are written out in PRIORITY order (see constants.js):
  // living (100) -> bedroom (85) -> bathroom (70) -> kitchen (60) ->
  // storage (40) -> balcony (25) -> front_door (10). This ordering is not
  // a coincidence - it guarantees that whenever a block below needs to look
  // up its attach-target's box (via placed.get(...)), that target has
  // ALREADY been placed, because every possible attach-target type has
  // strictly higher priority than every room type that attaches to it.
  // solver.js re-uses this exact ordering later for the same reason.

  // --- living: the public-zone anchor, placed first, at the plot's front edge ---
  // Only the MAIN living room (typeIndex 0 - byType.living is sorted by
  // typeIndex above, so it's always iterated first) goes in the actual
  // front row, sitting right at the plot's y = 0 boundary. attachMap.js
  // treats this same room (livings[0]) as the anchor everything else
  // orbits, so it's the one spot in the whole layout other room types
  // cluster around.
  //
  // Extra living rooms (typeIndex >= 1 - a second lounge/family room;
  // attachMap.js's own extension for completeness, not part of the literal
  // spec) used to be seeded in that SAME front row, immediately to the
  // right of living_0 (livingCursorX just kept incrementing for every
  // living room in the type). That collided with shared "hall" bathrooms,
  // which are ALSO seeded to living_0's right (see the bathroom block
  // below): two unrelated room types racing for the identical strip of
  // space, both equal-or-higher priority than the other so neither was
  // ever forced to yield, which the solver couldn't always fully untangle
  // within its iteration budget (confirmed: 5 bedrooms/3 bathrooms/2
  // living rooms/3 balconies/2 storage rooms left a real overlap).
  // Extra living rooms are placed BEHIND living_0 instead (the "back"
  // side - the same relative direction an en-suite bathroom uses behind
  // its bedroom), a corridor bathrooms never route through: a bathroom
  // only ever goes "right" of living (shared) or "back" of a BEDROOM
  // (never "back" of living itself).
  let livingCursorX = 0; // running left-to-right cursor for the front row (living_0 only)
  let livingRowBottomY = 0; // back edge of the whole living zone (front row + any extra livings behind it) - bedrooms start here
  let mainLivingBox = null; // living_0's own placed box, extra livings anchor off this
  let extraLivingStackIndex = 0; // fan-out slot for extra livings placed behind living_0
  for (const room of byType.living ?? []) {
    const size = sizeOf(room.type);
    let cx;
    let cy;
    if (!mainLivingBox) {
      cx = livingCursorX + size.w / 2;
      cy = size.h / 2; // top edge sits exactly at y = 0, the plot's front boundary
      livingCursorX += size.w + SEED_GAP;
    } else {
      ({ cx, cy } = placeAdjacent(mainLivingBox, size, "back", extraLivingStackIndex));
      extraLivingStackIndex += 1;
    }
    const box = { id: room.id, type: room.type, cx, cy, w: size.w, h: size.h };
    placed.set(room.id, box);
    if (!mainLivingBox) mainLivingBox = box;
    livingRowBottomY = Math.max(livingRowBottomY, cy + size.h / 2);
  }

  // --- bedroom: the private zone, one row directly behind living ---
  let bedroomCursorX = 0;
  for (const room of byType.bedroom ?? []) {
    const size = sizeOf(room.type);
    const cx = bedroomCursorX + size.w / 2;
    const cy = livingRowBottomY + SEED_GAP + size.h / 2;
    placed.set(room.id, { id: room.id, type: room.type, cx, cy, w: size.w, h: size.h });
    bedroomCursorX += size.w + SEED_GAP;
    // (room.typeIndex === 0 here is the "master" bedroom - buildAttachMap
    // already knows this and points balconies/bathrooms at it directly via
    // attachMap, so this file doesn't need to track it separately.)
  }

  // --- bathroom: parked immediately beside whatever it attaches to ---
  for (const room of byType.bathroom ?? []) {
    const size = sizeOf(room.type);
    const targetId = attachMap[room.id];
    const target = placed.get(targetId);
    if (!target) continue; // no attach target on record - skip rather than crash
    // An en-suite bathroom (target is a bedroom) can't safely go on the
    // bedroom's "right" side the way a shared bathroom off living can:
    // bedrooms are laid out as a contiguous row with only a small SEED_GAP
    // between them, so the very next bedroom in the row is usually
    // already sitting exactly where "right of this bedroom" would land,
    // which would seed a collision directly onto a HIGH-priority bedroom
    // (85) rather than a low-priority room that's expected to yield. The
    // space directly BEHIND a bedroom (further into the plot, away from
    // living), on the other hand, is still empty at this point in the
    // priority order - only living and the bedroom row have been placed
    // so far - so an en-suite bathroom goes there instead. A shared hall
    // bathroom (target is living) keeps using "right", since living's
    // right side has no such neighbour problem.
    const side = target.type === "bedroom" ? "back" : "right";
    const stackIndex = nextStackIndex(`${targetId}:bathroom`);
    const { cx, cy } = placeAdjacent(target, size, side, stackIndex);
    placed.set(room.id, { id: room.id, type: room.type, cx, cy, w: size.w, h: size.h });
  }

  // --- kitchen: beside living (opposite side from bathrooms, so they don't compete for the same space) ---
  for (const room of byType.kitchen ?? []) {
    const size = sizeOf(room.type);
    const targetId = attachMap[room.id];
    const target = placed.get(targetId);
    if (!target) continue;
    const stackIndex = nextStackIndex(`${targetId}:kitchen`);
    const { cx, cy } = placeAdjacent(target, size, "left", stackIndex);
    placed.set(room.id, { id: room.id, type: room.type, cx, cy, w: size.w, h: size.h });
  }

  // --- storage: beside its attach target (kitchen if one exists, else living) ---
  for (const room of byType.storage ?? []) {
    const size = sizeOf(room.type);
    const targetId = attachMap[room.id];
    const target = placed.get(targetId);
    if (!target) continue;
    // Storage always goes on its target's LEFT side - whether that target
    // is the kitchen (already sitting on living's left, per the kitchen
    // block above - continuing further left keeps storage moving AWAY from
    // living rather than doubling back into its footprint) or, when there
    // is no kitchen, living itself directly. Living's left side is
    // guaranteed free in that second case: nothing else in this file ever
    // places anything there except kitchen, and if a kitchen existed,
    // storage would be attaching to IT instead (see buildAttachMap.js), not
    // to living. Keeping storage off living's RIGHT side matters because
    // that's where shared "hall" bathrooms stack up (see the bathroom block
    // above) - piling storage into that same corridor on top of however
    // many bathrooms are already queued there is exactly what produced
    // seed-time collisions when testing programs with several bathrooms and
    // no kitchen.
    const side = "left";
    const stackIndex = nextStackIndex(`${targetId}:storage`);
    const { cx, cy } = placeAdjacent(target, size, side, stackIndex);
    placed.set(room.id, { id: room.id, type: room.type, cx, cy, w: size.w, h: size.h });
  }

  // --- balcony: hung off the OUTSIDE edge of its attach target ---
  for (const room of byType.balcony ?? []) {
    const size = sizeOf(room.type);
    const targetId = attachMap[room.id];
    const target = placed.get(targetId);
    if (!target) continue;
    // Bedrooms sit at the BACK of the plot, so "outward" from a bedroom is
    // further back still (side "back"). Living sits at the FRONT of the
    // plot, so "outward" from living is further forward (side "front").
    // Either way this pushes the balcony toward an edge nothing else in
    // the seed layout is beyond - matching the real requirement that a
    // balcony has to reach open air, not be boxed in by other rooms.
    const side = target.type === "bedroom" ? "back" : "front";
    const stackIndex = nextStackIndex(`${targetId}:balcony`);
    const { cx, cy } = placeAdjacent(target, size, side, stackIndex);
    placed.set(room.id, { id: room.id, type: room.type, cx, cy, w: size.w, h: size.h });
  }

  // --- front_door: at living's edge, right on the plot's front boundary ---
  for (const room of byType.front_door ?? []) {
    const size = sizeOf(room.type);
    const targetId = attachMap[room.id];
    const target = placed.get(targetId); // living
    if (!target) continue;
    const cx = target.cx - target.w / 2 + size.w / 2; // near living's left corner
    // The door's BOTTOM edge touches y = 0 (living's top edge, the plot's
    // front boundary) exactly, with the whole box sitting just in FRONT of
    // living (cy < 0) rather than centered ON y = 0. Centering it on y = 0
    // would put half the door box inside living's own footprint, which -
    // even though a real doorway does sit "in" a wall - reads to the
    // collision check as an actual overlap with living, giving the solver
    // a tiny but real collision to react to for no good reason. Touching
    // instead of overlapping avoids that, while still sitting right at the
    // front boundary and right next to living, satisfying both the
    // "exterior edge" and "adjacent to living" requirements cleanly.
    const cy = -size.h / 2;
    placed.set(room.id, { id: room.id, type: room.type, cx, cy, w: size.w, h: size.h });
  }

  // Return in the SAME order as the input `rooms` list (not the
  // type-by-type priority order used to compute positions above), so
  // downstream stages have a stable, predictable "declared order" without
  // needing to know anything about how this function walked the room list
  // internally.
  return rooms.map((room) => placed.get(room.id));
}
