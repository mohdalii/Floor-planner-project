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
//
// ===========================================================================
// REDESIGN (this pass) - replaces the previous "chain a wrapped room to its
// physical sibling" fix, not an addition to it. See the big design-rationale
// comment further down (just above edgeLength/peekEdgeSlot/commitEdgeSlot)
// for the full story: real ResPlan data showed that fix's trade-off doesn't
// match how real houses are built, and this file now spreads same-target
// siblings across the target's own real wall length instead of chaining them
// to each other. STATUS.md's Day 7-8 section has the complete before/after
// numbers.
// ===========================================================================

import { PRIORITY, SIZE_RANGES, HALLWAY_DEPTH_M } from "./constants.js";
import { estimatePlotDimensions } from "./plotSizing.js";

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
 * @returns {{
 *   rooms: Array<{id: string, type: string, cx: number, cy: number, w: number, h: number}>,
 *   attachMap: Object<string, string>,
 * }}
 *   `rooms` - one box per input room, IN THE SAME ORDER as the `rooms`
 *   input - so later stages (solver.js) get a stable "declared order" to
 *   use as a tie-break without needing to know anything about how
 *   buildRoomProgram built the list in the first place.
 *   `attachMap` - a RESOLVED copy of the input attachMap: identical to it
 *   for every room that ended up genuinely touching a real target - which,
 *   after this redesign, is nearly always its OWN nominal target (spread
 *   across the target's own full edge length, or a second edge of the same
 *   target - see the design comment below), and only overridden when a room
 *   ends up genuinely touching a DIFFERENT, valid target than its nominal
 *   one (storage falling back from kitchen to living - see the storage
 *   block below). This override is NEVER a same-type sibling (bathroom ->
 *   bathroom, storage -> storage) - that's precisely the trade-off this
 *   redesign removes. In the rare, genuinely extreme residual case where a
 *   room can't reach any valid target at all, this map is left UNCHANGED
 *   (not overridden to whatever sibling happens to be physically nearby),
 *   so doors.js/validate.js correctly and honestly report no real door
 *   there - a documented limitation, not a fabricated relationship. This is
 *   the return value callers should pass on to solveLayout()/placeDoors()/
 *   validateLayout() from here on.
 */
export function seedLayout(rooms, attachMap) {
  // Per-call copy that this function corrects in place for the rare
  // fallback-to-a-different-target case (storage) - starts as an exact copy
  // of the caller's attachMap (every entry keeps its original, correct
  // value unless overridden), so a program where every room fits its
  // nominal target (the common case) returns an attachMap that is
  // behaviourally identical to the input.
  const resolvedAttachMap = { ...attachMap };
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

  // ===========================================================================
  // Edge-based fan-out placement.
  //
  // THIS REPLACES THE OLD "claimPosition"/"chainParentId" MECHANISM FROM THE
  // PREVIOUS FIXER PASS (STATUS.md Day 7-8, "sealed shared-bathroom/storage
  // rooms fixed") - a real redesign, not a patch on top of it. That pass
  // fixed sealed shared-bathroom/storage rooms (rooms with literally zero
  // doors, because a fan-out stack's 2nd/3rd+ occupant only ever touched the
  // target's own edge if it happened to land in the FIRST wrapped column) by
  // CHAINING a wrapped occupant's attach-map entry to whichever SAME-TYPE
  // sibling it physically ended up beside (bathroom_1 -> bathroom_0,
  // storage_1 -> storage_0). A reviewer accepted that as a documented
  // trade-off at the time, reasoning that giving every occupant a direct
  // touch to the real target "isn't geometrically achievable once a fan-out
  // stack's combined size exceeds the target's own edge length".
  //
  // Real data says otherwise. Re-running data-analysis/analyze_connectivity.py
  // against the actual 17,000-plan ResPlan dataset (2026-09-01) shows:
  //   - A real DOOR directly between two bathrooms happens in only 66 of
  //     40,261 real bathrooms across multi-bathroom plans (0.16%) - it is
  //     essentially never how real houses connect a second bathroom. The
  //     previous fix made this the ROUTINE outcome (STATUS.md measured
  //     60.7% of the project's own 672-combo test grid getting a
  //     bathroom-to-bathroom or storage-to-storage chain) - the opposite of
  //     what real plans do.
  //   - Bathroom-to-bedroom (en-suite) is the single most common bathroom
  //     relationship by a wide margin (23,348 instances) - most "extra"
  //     bathrooms belong to a specific bedroom, not a shared cluster.
  //     attachMap.js's existing en-suite-first pairing already matches this
  //     (verified unchanged by this pass - see attachMap.js's own comment).
  //   - When a bathroom DOES connect directly to living (a "hall" bathroom),
  //     it's common for MULTIPLE bathrooms to each have their own
  //     independent door into that same shared space at once: 2,102 of
  //     16,848 multi-bathroom plans have living with a direct door to 2+
  //     bathrooms simultaneously. So there's no fundamental geometric reason
  //     a shared target can't have several independent doors - the previous
  //     fix's "not geometrically achievable" claim was a limitation of THAT
  //     specific column-wrap algorithm (it only ever used HALF of a target's
  //     own edge length before wrapping - see edgeLength's own comment
  //     below), not a real architectural constraint.
  //   - Bathrooms sharing a physical wall WITHOUT a door between them is
  //     very common (13,453 instances) - back-to-back bathrooms for
  //     plumbing efficiency are completely normal, AS LONG AS each one still
  //     has its own separate door elsewhere. That's exactly the distinction
  //     the previous fix blurred: it made a real wall between two bathrooms
  //     stand in for one of them having no other door at all, presenting a
  //     sealed room as "fixed" rather than genuinely reachable.
  //
  // The redesign: every room sharing one attach target gets a genuine,
  // independent slot along that target's own real wall, side-by-side, using
  // the FULL length of that edge (not just half of it - the single biggest
  // fix here, see edgeLength's own comment). Only once that whole edge is
  // genuinely out of room does a room try a SECOND edge of the SAME target
  // (a hall bathroom that doesn't fit on living's right side tries living's
  // left side next) - still a real, direct touch to the real target, never
  // a fabricated relationship to a same-type sibling. Storage additionally
  // gets a genuinely different fallback TARGET (living, if it doesn't fit
  // beside kitchen) - also not a same-type chain, and a real, plausible
  // pattern (a second storage/utility room off the main living area).
  //
  // Only in a genuinely extreme case - more same-type siblings sharing one
  // target than even a second edge can hold - does a room end up placed
  // without touching any valid target at all. That case is NOT papered over
  // by chaining it to whichever sibling happens to be physically nearby (the
  // previous fix's approach): resolvedAttachMap is simply left unchanged, so
  // doors.js/validate.js correctly and honestly report no real door there.
  // This is a deliberate, documented residual limitation - measured directly
  // (not assumed) across the project's own 672-combination test grid, see
  // STATUS.md's Day 7-8 redesign entry for the real before/after rate - not
  // a silent same-type link.
  // ===========================================================================

  // How far a target's own edge actually extends along the perpendicular
  // fan-out axis, for a given side - i.e. the real, full length of wall
  // available before a room placed there stops genuinely touching the
  // target. Only "right"/"left" get a finite bound (the target's own FULL
  // height) - "back"/"front" stay unbounded (Infinity): those sides are
  // used off a BEDROOM (an en-suite bathroom, the master's own balcony) or
  // off LIVING's own front edge, where there is no equivalent "something
  // important sits right after it" risk the way living's right/left sides
  // have (a hallway sits directly behind living - see constants.js's
  // HALLWAY_DEPTH_M comment - so a right/left fan-out that reached past
  // living's own height would collide with it).
  //
  // *** This is the FULL target height now, not half of it (the previous
  // version's bound). *** The old bound only let a fan-out use the HALF of
  // a target's edge from its own centre-line toward one corner (e.g.
  // living's centre down to its bottom-right corner), leaving the other
  // half (centre up to the top-right corner, right beside the front door's
  // own corner of the building) completely unused - not because anything
  // actually occupies that space, but purely because the old bound never
  // looked there. Doubling the amount of a target's own real wall a fan-out
  // is allowed to use, before it ever needs to consider a second edge at
  // all, is the single biggest, cheapest fix here - directly what "spread
  // them along the target's actual available edge(s), using real remaining
  // wall length" means in practice. Verified safe against the front door
  // specifically: the front door is a small marker box seeded ABOVE living
  // (negative y - see the front_door block far below), never sharing any
  // x/y range with living's own right/left edges, so using the full height
  // there can never collide with it.
  const edgeLength = (target, side) =>
    side === "right" || side === "left" ? target.h : Infinity;

  // edgeUsage tracks, per (target, side) key, how far that edge has been
  // filled so far - the perpendicular offset (from the target's own centre)
  // of the FAR edge of whichever occupant was placed there most recently.
  // Undefined until the first occupant claims that key. Note this is a
  // SIMPLER piece of state than the previous version's claimedColumn: there
  // is no "column index" any more, because this redesign never wraps into a
  // second stacked column behind the first (the mechanism that caused
  // chaining in the first place) - overflow is instead resolved by trying a
  // genuinely different (target, side) key entirely, chosen explicitly by
  // each call site below (see the bathroom-overflow and storage blocks).
  const edgeUsage = new Map();

  // Read-only: where would the NEXT occupant of `ownPerpExtent` land on
  // `key`, and would that position still be within the target's own real
  // edge length (`fits: true`) or run past it (`fits: false`)? Doesn't
  // change anything - callers use this to decide whether to commit here,
  // try a different edge/target, or (the rare, extreme case) accept the
  // overflow position anyway. `maxPerpExtent` is `edgeLength(target, side)`
  // from above, supplied by the caller rather than looked up here, since
  // some fallback attempts deliberately probe a DIFFERENT target/side than
  // the room's own primary one.
  const peekEdgeSlot = (key, ownPerpExtent, maxPerpExtent) => {
    const halfExtent = maxPerpExtent / 2; // the edge spans [-halfExtent, +halfExtent] around the target's own centre-line - using the FULL edge, both directions from centre, not just one
    const usedFarEdge = edgeUsage.get(key);
    let perpOffset;
    if (usedFarEdge === undefined) {
      // First occupant. When the bound is finite, start flush against the
      // near end of the FULL edge (see the big comment above for why this
      // uses the whole edge, not just the half the previous version used).
      // When the bound is Infinity ("back"/"front" sides - no real target
      // edge to be "flush against" in the first place), there is no
      // near-end reference point to flush against, so fall back to the
      // target's own centre-line (perpOffset 0) - the same starting point
      // every unbounded side has always used. Finite-minus-Infinity is
      // -Infinity in JS, so this branch is load-bearing, not defensive
      // styling - without it, every en-suite bathroom/extra balcony/extra
      // living room (all unbounded sides) would seed at cx/cy = -Infinity.
      perpOffset = Number.isFinite(halfExtent) ? -halfExtent + ownPerpExtent / 2 : 0;
    } else {
      // Next occupant: right after the previous one's far edge - correct
      // regardless of whether the bound is finite or Infinity.
      perpOffset = usedFarEdge + SEED_GAP + ownPerpExtent / 2;
    }
    const fits = perpOffset + ownPerpExtent / 2 <= halfExtent + 1e-9; // tiny epsilon against float noise at the exact boundary; always true when halfExtent is Infinity
    return { perpOffset, fits };
  };

  // Actually claims the slot `peekEdgeSlot` reported for `key` (whatever its
  // `perpOffset` was, fits or not - the rare residual case still needs the
  // bookkeeping updated so a THIRD sibling, if one exists, stacks after this
  // one instead of on top of it).
  const commitEdgeSlot = (key, ownPerpExtent, perpOffset) => {
    edgeUsage.set(key, perpOffset + ownPerpExtent / 2);
  };

  // The fan-out axis depends on the side: "right"/"left" spread rooms
  // vertically (perpOffset added to cy in placeAdjacent below), so the
  // perpendicular extent is the room's HEIGHT; "back"/"front" do the
  // opposite (perpOffset added to cx), so it's the room's WIDTH.
  const perpExtentFor = (size, side) => (side === "right" || side === "left" ? size.h : size.w);

  // Computes a position for `size` immediately next to `target`'s box, on
  // the given side, offset along the perpendicular fan-out axis by
  // `perpOffset` (a real unit-space length from the target's own centre,
  // not a slot count). Unlike the previous version, there is no separate
  // "alongOffset" parameter any more - this redesign never places a second
  // occupant further OUT from the target (which is what used to create a
  // sibling-touching, target-missing room) - every occupant sits directly
  // against the target's own wall, at a different point along it.
  const placeAdjacent = (target, size, side, perpOffset) => {
    switch (side) {
      case "right":
        return {
          cx: target.cx + target.w / 2 + SEED_GAP + size.w / 2,
          cy: target.cy + perpOffset,
        };
      case "left":
        return {
          cx: target.cx - target.w / 2 - SEED_GAP - size.w / 2,
          cy: target.cy + perpOffset,
        };
      case "back": // further from the plot's front edge (larger y)
        return {
          cx: target.cx + perpOffset,
          cy: target.cy + target.h / 2 + SEED_GAP + size.h / 2,
        };
      case "front": // toward the plot's front edge (smaller y)
        return {
          cx: target.cx + perpOffset,
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

  // The blocks below are broadly written out in PRIORITY order (see
  // constants.js): living (100) -> bedroom (85) -> hallway (80) ->
  // bathroom (70) -> kitchen (60) -> storage (40) -> balcony (25) ->
  // front_door (10) - so that whenever a block needs to look up its
  // attach-target's box (via placed.get(...)), that target has ALREADY
  // been placed, because every possible attach-target type has strictly
  // higher priority than every room type that attaches to it. solver.js
  // re-uses this exact ordering later for the same reason.
  //
  // Exceptions to that strict ordering, all explained where they happen
  // below:
  //
  //  1. hallway isn't placed "beside its attach target" the way every
  //     lower-priority block is - it has to be placed right after the
  //     bedroom row, because its own geometry (width) is DERIVED from the
  //     bedroom row's actual extent.
  //
  //  2. bathroom is placed in TWO PASSES, one before the bedroom row and
  //     one after (see placeBathrooms() below): a SHARED "hall" bathroom
  //     (target = living) doesn't need bedrooms to exist yet, and living's
  //     own extent has to be fully claimed (including any hall-bathroom
  //     overflow) before the bedroom row/hallway are positioned relative to
  //     it - same reasoning the previous pass established for why this
  //     two-pass split exists at all (see STATUS.md Day 7-8 for the
  //     original hallway-overlap bug this ordering prevents).
  //
  //  3. a THIRD, brand-new step in this pass - hall-bathroom overflow
  //     resolution - runs after kitchen (which also fans out off living's
  //     left edge) is placed, and before storage: any hall bathroom that
  //     didn't fit on living's right edge (pass 1 above) gets a genuine
  //     shot at living's LEFT edge here, before this file falls back to
  //     accepting a documented residual limit. See that block's own comment
  //     for why ordering it after kitchen (rather than before) doesn't
  //     actually matter for correctness here, unlike it would have under
  //     the old column-wrap mechanism.

  // --- living: the public-zone anchor, placed first, at the plot's front edge ---
  // Only the MAIN living room (typeIndex 0 - byType.living is sorted by
  // typeIndex above, so it's always iterated first) goes in the actual
  // front row, sitting right at the plot's y = 0 boundary. attachMap.js
  // treats this same room (livings[0]) as the anchor everything else
  // orbits, so it's the one spot in the whole layout other room types
  // cluster around.
  //
  // Extra living rooms (typeIndex >= 1) are placed BEHIND living_0 (the
  // "back" side) rather than beside it - see roomProgram.js Step 2b for why
  // this is dead code today (`livingRooms` is capped to exactly 1) and
  // STATUS.md's Day 3-5 section for the seeding-collision history that led
  // to "back" being the right side for this, back when it was reachable.
  // Kept working and updated to this pass's new edge-based mechanism rather
  // than deleted, since it's harmless and a real starting point if
  // multi-living is ever un-capped later.
  let livingCursorX = 0; // running left-to-right cursor for the front row (living_0 only)
  let livingRowBottomY = 0; // back edge of the whole living zone (front row + any extra livings behind it) - bedrooms start here
  let mainLivingBox = null; // living_0's own placed box, extra livings/every fan-out below anchors off this
  for (const room of byType.living ?? []) {
    const size = sizeOf(room.type);
    let cx;
    let cy;
    if (!mainLivingBox) {
      cx = livingCursorX + size.w / 2;
      cy = size.h / 2; // top edge sits exactly at y = 0, the plot's front boundary
      livingCursorX += size.w + SEED_GAP;
    } else {
      const key = `${mainLivingBox.id}:back`;
      const ownPerpExtent = perpExtentFor(size, "back");
      const { perpOffset } = peekEdgeSlot(key, ownPerpExtent, edgeLength(mainLivingBox, "back"));
      commitEdgeSlot(key, ownPerpExtent, perpOffset);
      ({ cx, cy } = placeAdjacent(mainLivingBox, size, "back", perpOffset));
    }
    const box = { id: room.id, type: room.type, cx, cy, w: size.w, h: size.h };
    placed.set(room.id, box);
    if (!mainLivingBox) mainLivingBox = box;
    livingRowBottomY = Math.max(livingRowBottomY, cy + size.h / 2);
  }

  // --- bathroom pass 1: hall bathrooms that fit on living's right edge ----
  // En-suite bathrooms (target is a bedroom, which doesn't exist yet) are
  // skipped here via `if (!target) continue` and picked up by pass 2, after
  // the bedroom row, unchanged from before this redesign.
  //
  // A hall bathroom (target is living) that DOESN'T fit on living's right
  // edge is not placed here at all - it's queued in hallBathroomOverflow
  // for the dedicated overflow-resolution step below (after kitchen), which
  // tries living's LEFT edge next: a real second edge of the same real
  // target, not a chain to a sibling bathroom.
  const hallBathroomOverflow = [];
  const placeBathrooms = () => {
    for (const room of byType.bathroom ?? []) {
      if (placed.has(room.id)) continue;
      const size = sizeOf(room.type);
      const targetId = attachMap[room.id];
      const target = placed.get(targetId);
      if (!target) continue; // en-suite target (a bedroom) isn't placed yet - pass 2 handles it

      const side = target.type === "bedroom" ? "back" : "right";
      const ownPerpExtent = perpExtentFor(size, side);
      const key = `${targetId}:${side}`;
      const { perpOffset, fits } = peekEdgeSlot(key, ownPerpExtent, edgeLength(target, side));

      if (!fits && side === "right") {
        hallBathroomOverflow.push(room);
        continue;
      }

      // Either it genuinely fits living's right edge (the common case - see
      // STATUS.md's Day 7-8 redesign entry for how often this alone is
      // enough: median-sized real-data bathrooms mean living's FULL right
      // edge comfortably holds 2 hall bathrooms, which covers the large
      // majority of realistic room programs including the project's own
      // recurring 3-bed/2-bath demo), or it's an en-suite bathroom (side
      // "back", unbounded per edgeLength - always fits, one bathroom per
      // bedroom, no fan-out collision possible there).
      commitEdgeSlot(key, ownPerpExtent, perpOffset);
      const { cx, cy } = placeAdjacent(target, size, side, perpOffset);
      placed.set(room.id, { id: room.id, type: room.type, cx, cy, w: size.w, h: size.h });
    }
  };
  placeBathrooms(); // pass 1: hall bathrooms that fit living's right edge, plus (in practice none yet) any en-suite bathroom whose target already happens to exist

  // --- kitchen: beside living, on its LEFT side (opposite hall bathrooms) -
  for (const room of byType.kitchen ?? []) {
    const size = sizeOf(room.type);
    const targetId = attachMap[room.id];
    const target = placed.get(targetId);
    if (!target) continue;
    const ownPerpExtent = perpExtentFor(size, "left");
    const key = `${targetId}:left`;
    const { perpOffset } = peekEdgeSlot(key, ownPerpExtent, edgeLength(target, "left"));
    // Committed unconditionally, even in the (practically never observed -
    // roomProgram.js only ever produces a single kitchen today, and one
    // median-sized kitchen is well within living's own full edge length)
    // case where `fits` came back false: kitchen has no fallback side of
    // its own in this design (storage, not kitchen, is the room type with a
    // real second TARGET to fall back to - see the storage block below),
    // and a kitchen not touching living at all would break the HARD,
    // zero-tolerance kitchenAdjacentToLiving check regardless of what else
    // was tried, so there is no better option than placing it here.
    commitEdgeSlot(key, ownPerpExtent, perpOffset);
    const { cx, cy } = placeAdjacent(target, size, "left", perpOffset);
    placed.set(room.id, { id: room.id, type: room.type, cx, cy, w: size.w, h: size.h });
  }

  // --- hall-bathroom overflow resolution: try living's LEFT edge next -----
  // The concrete "spread along the target's actual available edge(s)...
  // only wrap to a second edge of the SAME target" mechanism this redesign
  // is built around (see the big design comment above). Runs after kitchen
  // purely to match this file's existing convention of giving kitchen first
  // claim on living's left side - NOT because correctness depends on it:
  // every occupant on a shared (target, side) queue is placed at the SAME
  // distance from the target (only its position ALONG the wall differs), so
  // it genuinely touches the target directly regardless of queue order or
  // which other room types share that queue.
  for (const room of hallBathroomOverflow) {
    const size = sizeOf(room.type);
    const targetId = attachMap[room.id]; // always living_0 for a hall bathroom
    const target = placed.get(targetId);
    const ownPerpExtent = perpExtentFor(size, "left");
    const fallbackKey = `${targetId}:left`;
    const fallback = peekEdgeSlot(fallbackKey, ownPerpExtent, edgeLength(target, "left"));

    if (fallback.fits) {
      // A genuine second edge of the real target - still directly touching
      // living, just via its left wall instead of its right one. No
      // resolvedAttachMap override needed: the room's ORIGINAL target
      // (living) is exactly what it's now touching.
      commitEdgeSlot(fallbackKey, ownPerpExtent, fallback.perpOffset);
      const { cx, cy } = placeAdjacent(target, size, "left", fallback.perpOffset);
      placed.set(room.id, { id: room.id, type: room.type, cx, cy, w: size.w, h: size.h });
      continue;
    }

    // Genuinely extreme residual case (measured directly across the
    // project's own 672-combo test grid - see STATUS.md's Day 7-8 redesign
    // entry for the real rate; this branch is reached far less often than
    // the previous chaining fix's ~60%). Per this redesign's explicit goal,
    // this does NOT get chained to whichever sibling bathroom happens to
    // end up physically nearest (the previous fix's approach): resolvedAttachMap
    // is left EXACTLY as buildAttachMap() originally set it ("-> living"),
    // which may no longer be physically true. doors.js/validate.js will
    // correctly and honestly report this room as having no real shared
    // wall with its target, instead of a fabricated one - a documented,
    // rare residual limitation, not a silently invented same-type
    // relationship.
    //
    // It still needs SOME concrete, non-overlapping position for the solver
    // to refine from, though. Extends the FALLBACK (left) queue further,
    // past ITS OWN real bound too, rather than going back to the right
    // queue: living's left-side placements always sit at a fixed, negative
    // cx (target.cx - target.w/2 - gap - size.w/2 - see placeAdjacent's
    // "left" case - perpOffset only ever moves them along cy, never cx), so
    // extending that queue further down in cy can never cross into the
    // bedroom row/hallway's own x-range (which starts at x = 0 - see the
    // bedroom/hallway blocks below). Extending the RIGHT queue instead
    // (tried first, reverted) does NOT have this safety property - it grows
    // toward larger cy AND stays at a large positive cx, i.e. directly
    // toward the hallway's own zone, reproducing overlaps the solver's
    // safety net couldn't always fully untangle (confirmed directly: this
    // was the actual cause of a real noOverlaps regression during this
    // pass's own testing, fixed by this left-queue extension instead).
    commitEdgeSlot(fallbackKey, ownPerpExtent, fallback.perpOffset);
    const { cx, cy } = placeAdjacent(target, size, "left", fallback.perpOffset);
    placed.set(room.id, { id: room.id, type: room.type, cx, cy, w: size.w, h: size.h });
  }

  // --- storage: beside kitchen if there is one, else beside living directly
  for (const room of byType.storage ?? []) {
    const size = sizeOf(room.type);
    const nominalTargetId = attachMap[room.id]; // kitchen_0 if a kitchen exists, else living_0 (see attachMap.js)
    const nominalTarget = placed.get(nominalTargetId);
    if (!nominalTarget) continue;
    const ownPerpExtent = perpExtentFor(size, "left");
    const primaryKey = `${nominalTargetId}:left`;
    const primary = peekEdgeSlot(primaryKey, ownPerpExtent, edgeLength(nominalTarget, "left"));

    if (primary.fits) {
      commitEdgeSlot(primaryKey, ownPerpExtent, primary.perpOffset);
      const { cx, cy } = placeAdjacent(nominalTarget, size, "left", primary.perpOffset);
      placed.set(room.id, { id: room.id, type: room.type, cx, cy, w: size.w, h: size.h });
      continue;
    }

    // Doesn't fit beside its nominal target. If that target was KITCHEN
    // (not living itself), living is a real, different, second target to
    // try - a plausible real pattern too (a second storage/utility room off
    // the main living area, not necessarily right beside the kitchen).
    // Re-points resolvedAttachMap to living in that case, since a
    // genuinely different, valid target is exactly what this room ends up
    // touching - NOT a same-type chain (storage-to-storage), which this
    // redesign exists to eliminate. The real ResPlan data backs treating
    // storage more simply than bathroom here: only 15 of 17,000 real plans
    // even have 2+ storage rooms at all (data-analysis/analyze_connectivity.py),
    // so a single extra fallback target, rather than a second full edge the
    // way hall bathrooms get, is proportionate.
    if (nominalTarget.type === "kitchen") {
      const fallbackKey = `${mainLivingBox.id}:left`;
      const fallback = peekEdgeSlot(fallbackKey, ownPerpExtent, edgeLength(mainLivingBox, "left"));
      if (fallback.fits) {
        commitEdgeSlot(fallbackKey, ownPerpExtent, fallback.perpOffset);
        const { cx, cy } = placeAdjacent(mainLivingBox, size, "left", fallback.perpOffset);
        placed.set(room.id, { id: room.id, type: room.type, cx, cy, w: size.w, h: size.h });
        resolvedAttachMap[room.id] = mainLivingBox.id;
        continue;
      }
    }

    // Genuinely extreme residual case - same honest-non-chaining principle
    // as the hall-bathroom overflow case above: place it (extending the
    // nominal target's own queue past its real bound, so the solver still
    // has valid, non-overlapping coordinates to work with) but leave
    // resolvedAttachMap exactly as buildAttachMap() set it, so this shows
    // up as a documented, rare residual limitation instead of a fabricated
    // storage-to-storage relationship.
    commitEdgeSlot(primaryKey, ownPerpExtent, primary.perpOffset);
    const { cx, cy } = placeAdjacent(nominalTarget, size, "left", primary.perpOffset);
    placed.set(room.id, { id: room.id, type: room.type, cx, cy, w: size.w, h: size.h });
  }

  // Note: livingRowBottomY is NOT widened here to account for the shared
  // bathroom/kitchen/storage occupants just placed above. That's a
  // deliberate difference, not an oversight: every (target, side) edge
  // above is bounded by edgeLength to stay within the target's own actual
  // extent - i.e. within living's own footprint - so nothing placed via
  // placeBathrooms/the overflow pass/the kitchen/storage blocks above can
  // reach past living's own bottom edge in the first place (except the
  // rare, genuinely extreme residual case, which the solver's collision
  // safety net resolves the same way it always has for any leftover
  // overlap - see solver.js). living's own footprint (set in the living
  // block above) is already a correct, sufficient bound for where the
  // bedroom row/hallway need to start.

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

  // --- hallway: strip between living and the bedroom row, spanning the row's actual width ---
  // A shared connector that borders living on one side and the WHOLE
  // bedroom row on the other, so every individual bedroom genuinely shares
  // a wall segment with it - not just one specific bedroom the way an
  // en-suite bathroom or balcony attaches to only ONE. "Genuinely" is
  // checked BY CONSTRUCTION below (matching y-coordinates exactly, not
  // "close enough"), not left to the solver/WALL_SNAP to paper over later.
  //
  // Computed from the bedroom boxes ACTUALLY placed just above (their real
  // cx/cy/w/h), not from bedroomCursorX bookkeeping, so this stays correct
  // even if bedroom sizing/placement ever changes independently of this
  // block.
  const bedroomBoxes = (byType.bedroom ?? []).map((room) => placed.get(room.id));
  if (bedroomBoxes.length > 0) {
    const rowMinX = Math.min(...bedroomBoxes.map((b) => b.cx - b.w / 2));
    const rowMaxX = Math.max(...bedroomBoxes.map((b) => b.cx + b.w / 2));
    // Every bedroom shares the type "bedroom", so sizeOf() gave every one
    // of them the exact same target size - which means every bedroom's own
    // top (front) edge already sits at the exact same y-coordinate. That's
    // what makes "the hallway's back edge exactly matches the bedroom
    // row's front edge" a statement that's true for EVERY bedroom
    // individually (checked by construction: rowFrontY below IS that one
    // shared coordinate, not an approximation of it), not just
    // approximately true for the row as a whole.
    const rowFrontY = Math.min(...bedroomBoxes.map((b) => b.cy - b.h / 2));

    // Real-world corridor depth (constants.js), converted into this file's
    // unit space via the same metersPerUnit factor solver.js/wallNetwork.js
    // use elsewhere - estimatePlotDimensions() only ever reads each room's
    // `.type`, never a position, so re-deriving it here on the full
    // room-program list is exactly as safe as every other call site's own
    // re-derivation of the same factor (see wallNetwork.js's comment on
    // this same pattern).
    const { metersPerUnit } = estimatePlotDimensions(rooms);
    const hallwayDepth = HALLWAY_DEPTH_M / metersPerUnit;

    const hallwayW = rowMaxX - rowMinX;
    const hallwayCx = (rowMinX + rowMaxX) / 2;
    // The hallway's own front (top) edge sits exactly where the bedroom
    // row's front edge USED to be - touching living with the same SEED_GAP
    // every other living-adjacent room in this file uses. The bedroom row
    // is then shifted back by the hallway's full depth (+ one more
    // SEED_GAP) so the row's NEW front edge exactly touches the hallway's
    // back edge - by construction, computed directly from hallwayDepth,
    // not by hoping two independently-computed numbers happen to land
    // close together.
    const hallwayFrontY = rowFrontY;
    const hallwayCy = hallwayFrontY + hallwayDepth / 2;
    const shiftY = hallwayDepth + SEED_GAP;

    for (const box of bedroomBoxes) {
      placed.set(box.id, { ...box, cy: box.cy + shiftY });
    }

    // byType.hallway ?? [] mirrors every other block's defensive style in
    // this file (e.g. `if (!target) continue`) - buildRoomProgram() always
    // adds exactly one hallway, but seedLayout() can in principle be called
    // directly with a hand-built room list that omits one.
    const hallwayRoom = (byType.hallway ?? [])[0];
    if (hallwayRoom) {
      placed.set(hallwayRoom.id, {
        id: hallwayRoom.id,
        type: hallwayRoom.type,
        cx: hallwayCx,
        cy: hallwayCy,
        w: hallwayW,
        h: hallwayDepth,
      });
    }
  }

  placeBathrooms(); // pass 2: en-suite bathrooms (target is now a real, placed bedroom)

  // --- balcony: hung off the OUTSIDE edge of its attach target ---
  for (const room of byType.balcony ?? []) {
    const size = sizeOf(room.type);
    const targetId = attachMap[room.id];
    const target = placed.get(targetId);
    if (!target) continue;
    // Living sits at the FRONT of the plot, so "outward" from living is
    // further forward (side "front") - pushes extra balconies toward an
    // edge nothing else in the seed layout is beyond, matching the real
    // requirement that a balcony has to reach open air.
    //
    // A bedroom's own balcony (only ever the MASTER's - attachMap.js's
    // rule gives target.type === "bedroom" exclusively to bedroom_0, the
    // first/leftmost bedroom in the row) goes to its LEFT side, not "back"
    // (which is where its en-suite bathroom sits) - bedroom_0 is always the
    // row's leftmost bedroom, so x < 0 in its own Y-band is guaranteed
    // empty, letting the balcony genuinely touch bedroom_0 without
    // competing with bathroom_0's own "back" placement.
    const side = target.type === "bedroom" ? "left" : "front";
    const ownPerpExtent = perpExtentFor(size, side);
    const key = `${targetId}:${side}`;
    const { perpOffset } = peekEdgeSlot(key, ownPerpExtent, edgeLength(target, side));
    // Both uses of this block are unbounded ("left" off a bedroom, "front"
    // off living - edgeLength only bounds "right"/"left" fan-outs whose
    // target is close enough to something behind it to risk a collision;
    // neither of THESE particular (target, side) combinations is), so this
    // always fits in practice - committed unconditionally, same as kitchen
    // above, since no fallback is needed.
    commitEdgeSlot(key, ownPerpExtent, perpOffset);
    const { cx, cy } = placeAdjacent(target, size, side, perpOffset);
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
  // internally. `attachMap` is the resolved copy built up above - see this
  // function's own JSDoc for why callers should use THIS one, not the
  // plain input attachMap, for every stage from here on.
  return { rooms: rooms.map((room) => placed.get(room.id)), attachMap: resolvedAttachMap };
}
