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
 *   for every room that ended up genuinely touching its nominal target, but
 *   overridden for any room claimPosition had to wrap into a second (or
 *   third, ...) fan-out column, so its value always points at whichever
 *   room this one is ACTUALLY touching, not just its original label. This
 *   is the return value callers should pass on to solveLayout()/
 *   placeDoors()/validateLayout() from here on - see the big comment on
 *   claimPosition above for why the plain input attachMap can no longer be
 *   trusted for that on its own once a stack has wrapped.
 */
export function seedLayout(rooms, attachMap) {
  // Per-call copy that this function corrects in place as chained rooms are
  // discovered below - starts as an exact copy of the caller's attachMap
  // (every entry keeps its original, correct value unless overridden), so a
  // program with no wrapped stacks at all (the common case) returns an
  // attachMap that is behaviourally identical to the input.
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

  // Multiple rooms can attach to the SAME target on the SAME side (e.g. two
  // shared hall bathrooms both attaching to living's right side, or -
  // before this pass's fix below - an en-suite bathroom and the master's
  // own balcony both attaching "behind" the same bedroom). claimedColumn
  // tracks how much REAL space (not just an abstract slot count) has
  // already been claimed along a given (target, side) pair's fan-out axis,
  // so the next room placed there starts exactly where the previous one's
  // footprint actually ended, however differently sized the two rooms are.
  //
  // The key is `${targetId}:${side}` - target AND side, not target and
  // "role" (bathroom/balcony/...) the way this used to be keyed - so ANY
  // two rooms that resolve to the same target+side automatically fan out
  // instead of both claiming the same spot, without needing a separate
  // "which two roles might compete" case analysis. This mattered directly
  // for the reproduced bug this pass fixed: bathroom's en-suite placement
  // and balcony's master-balcony placement used to BOTH resolve to
  // target=bedroom_i, side="back" for the master bedroom, and under the
  // OLD per-role keying (`${targetId}:bathroom` vs `${targetId}:balcony`)
  // neither knew about the other, so both claimed slot 0 and seeded
  // directly on top of each other (reproduced: requesting {bedrooms:2,
  // bathrooms:3, balconies:2, ...} left balcony_0 2.148m from bedroom_0
  // after solving - solver.js's collision-avoidance pushed the
  // lower-priority balcony out of the higher-priority bathroom's way, but
  // "minimal movement" only ever pushes it juuust far enough to stop
  // overlapping, never back onto its actual attach target).
  //
  // The FULL fix for that reproduced bug ended up being two-part, not
  // one: this target+side keying (so anything that DOES end up sharing a
  // key fans out safely instead of colliding), PLUS giving the master's
  // balcony a genuinely different side ("left" of its bedroom, not "back")
  // so it no longer shares bathroom's key at all in the first place - see
  // the balcony block far below for why "back" alone, even with safe
  // fan-out, still wasn't the right fix (their combined width can
  // genuinely exceed one bedroom's own width, and every alternative within
  // "back" traded one collision for a different one).
  //
  // claimedColumn stores, per key, { colIndex, colFarEdge }: how far the
  // CURRENT column's occupants extend outward from the target's own
  // centre-line along the fan-out axis, and which column (0, 1, 2, ...) is
  // currently being filled. This has to track a real edge position, not
  // just accumulate a running sum of sizes: placeAdjacent below always
  // centres a room at `target.cx/cy + perpOffset`, so if two
  // DIFFERENT-sized rooms ever share a key, a naive "sum of extents"
  // offset would only guarantee no overlap when each new occupant is no
  // BIGGER than the one before it. Tracking the actual far edge and
  // placing each new occupant's NEAR edge (not its centre) at that
  // boundary + SEED_GAP is correct regardless of which occupant is bigger.
  //
  // The COLUMN part is what this pass added on top of that: without it, a
  // long enough stack (e.g. several shared "hall" bathrooms fanning out
  // along living's right side) can grow past the TARGET's own extent along
  // the fan-out axis and reach into whatever sits directly behind the
  // target - which, since this pass added an automatic hallway directly
  // behind living, is now a real, previously-nonexistent room to collide
  // with (reproduced directly: 2 shared bathrooms stacked on living's
  // right side already reached almost exactly to where living's own zone
  // was assumed to end, even before hallway existed - hallway spanning the
  // FULL bedroom row's width turned that near-miss into a genuine,
  // unresolvable seed-time overlap the solver's collision safety net then
  // "resolved" by cascading the bathroom far enough away from living to
  // lose its door entirely - see doors.js's self-check, which caught it;
  // no existing validate.js check did). Rather than trying to reposition
  // the hallway/bedroom row to dodge whatever a stack happens to claim (a
  // single rectangular hallway can't touch living at one y for part of its
  // width while dodging a stack at a different y for the rest - there's no
  // way to satisfy both), this bounds the stack itself: once adding another
  // occupant to the current column would push it past `maxPerpExtent`
  // (typically the target's own extent along the fan-out axis), a NEW
  // column starts instead - shifted further out along the SAME side,
  // resetting the perpendicular offset back to 0. A single occupant is
  // always allowed even if it alone exceeds maxPerpExtent (nothing smaller
  // would fit any better either).
  // *** Reachability fix (this pass) - see the long comment block below the
  // living/bedroom/hallway placement blocks for the full diagnosis, and
  // STATUS.md's Day 7-8 reviewer/fixer entries for the numbers. Short
  // version: claimPosition's column-wrap (added by an earlier pass, to stop
  // a long stack from reaching into the hallway's zone) only keeps the
  // FIRST occupant of a fan-out genuinely touching the real target - every
  // occupant that gets wrapped into column 1, 2, 3, ... only ever touches
  // the SIBLING occupant physically beside it (the previous column's
  // matching occupant, or the previous occupant stacked in its own column),
  // never the target itself, because the target's own edge only has so much
  // physical length - once a stack's combined size exceeds it, there is no
  // way for every occupant to simultaneously reach it, no matter how the
  // stack is arranged. attachMap.js, though, kept telling doors.js "this
  // room's target is `living`" regardless of which column it landed in - a
  // label that stopped matching the physical geometry the moment a second
  // column existed, so doors.js correctly found no real shared wall there
  // and cut no door at all.
  //
  // The fix: claimPosition now also returns `chainParentId` - the id of
  // whichever ALREADY-PLACED sibling room this one is actually guaranteed
  // to be touching, or `null` if it's genuinely touching the real target
  // directly (always true for column 0, since column 0 is bounded to stay
  // within the target's own extent - see maxPerpExtentFor). Every call site
  // below uses this to correct `resolvedAttachMap` (a per-call copy of the
  // input attachMap - see its own comment further down) so a chained room's
  // EFFECTIVE target is whatever it's really touching, not just its
  // nominal, possibly-physically-false attachMap label. This is exactly
  // Option A from this pass's brief ("attach-map chaining"): the alternative
  // (Option B, making every occupant fit directly against the target's own
  // edge) isn't geometrically achievable once a stack's combined size
  // exceeds the target's own edge length, no matter how it's arranged -
  // there is only so much of that one wall to go around. Chaining instead
  // rides the adjacency claimPosition's own geometry ALREADY guarantees
  // between consecutive stack members, turning a broken direct link into a
  // valid multi-hop path back to the target.
  //
  // Two cases, matching the two ways a new occupant can be placed:
  //   1. It fits in the CURRENT column (perpOffset advances but doesn't
  //      wrap): by construction (see the return statement below - each new
  //      occupant's near edge starts exactly at the previous occupant's far
  //      edge + SEED_GAP), it's touching whichever occupant was placed
  //      immediately before it IN THIS SAME COLUMN. If that's column 0, the
  //      chain parent is still `null` (every column-0 occupant already
  //      individually touches the real target too - see the big comment
  //      above `maxPerpExtentFor` - so there's no need to route through a
  //      sibling when the direct link already holds).
  //   2. It doesn't fit, and wraps into a NEW column: the new column always
  //      starts at perpOffset 0 (see the reset below), which is exactly
  //      where the PREVIOUS column's FIRST occupant also sits - so the two
  //      are guaranteed to share the same perpendicular band and be
  //      adjacent across the column boundary, regardless of how many OTHER
  //      occupants ended up stacked further down in either column. The
  //      chain parent is therefore that previous column's first occupant
  //      (`state.colFirstId`, captured before the column resets) - NOT
  //      whichever occupant happened to be placed most recently overall,
  //      which could be stacked deep in the previous column and share no
  //      real edge with this one at all.
  const claimedColumn = new Map();
  const claimPosition = (key, ownPerpExtent, ownAlongExtent, maxPerpExtent, roomId) => {
    const state = claimedColumn.get(key);

    if (!state) {
      // First room ever claimed under this key: always column 0, perpOffset
      // 0 - genuinely touches the real target directly, so no chaining
      // needed (chainParentId stays null).
      claimedColumn.set(key, { colIndex: 0, colFarEdge: ownPerpExtent / 2, colFirstId: roomId, lastId: roomId });
      return { perpOffset: 0, alongOffset: 0, chainParentId: null };
    }

    const candidatePerpOffset = state.colFarEdge + SEED_GAP + ownPerpExtent / 2;
    if (candidatePerpOffset + ownPerpExtent / 2 <= maxPerpExtent) {
      // Still fits in the CURRENT column - case 1 above.
      const perpOffset = candidatePerpOffset;
      const chainParentId = state.colIndex === 0 ? null : state.lastId;
      state.colFarEdge = perpOffset + ownPerpExtent / 2;
      state.lastId = roomId;
      claimedColumn.set(key, state);
      return { perpOffset, alongOffset: state.colIndex * (ownAlongExtent + SEED_GAP), chainParentId };
    }

    // Doesn't fit - wrap into a NEW column - case 2 above.
    const chainParentId = state.colFirstId;
    const newState = { colIndex: state.colIndex + 1, colFarEdge: ownPerpExtent / 2, colFirstId: roomId, lastId: roomId };
    claimedColumn.set(key, newState);
    return { perpOffset: 0, alongOffset: newState.colIndex * (ownAlongExtent + SEED_GAP), chainParentId };
  };

  // The fan-out axis - and so which of `size`'s two dimensions is the
  // relevant "own extent" for claimPosition above - depends on the side:
  // "right"/"left" stack multiple rooms vertically (perpOffset added to cy
  // in placeAdjacent below, columns fan out further along cx), so the
  // perpendicular extent is the room's HEIGHT and the along extent is its
  // WIDTH; "back"/"front" do the opposite (perpOffset along cx, columns
  // fan out along cy). Centralised here so every call site below uses the
  // axes that actually match the side it's placing on.
  const fanOutExtent = (size, side) =>
    side === "right" || side === "left"
      ? { perp: size.h, along: size.w }
      : { perp: size.w, along: size.h };

  // How far a fan-out column is allowed to extend along the perpendicular
  // axis before claimPosition wraps it into a new column.
  //
  // ONLY "right"/"left" get a real bound (the target's own HALF-HEIGHT,
  // since perpOffset there is measured relative to the target's own
  // centre along cy) - because that's the one case with a genuine reason
  // to bound it: "right"/"left" is used off LIVING (shared hall bathrooms,
  // kitchen, storage), and living now has the hallway sitting directly
  // behind it (see the big ordering comment above) - a stack that grows
  // past living's own height would reach into the hallway's zone.
  //
  // "back"/"front" get NO bound (Infinity) - deliberately, not an
  // oversight. This side is used off a BEDROOM (an en-suite bathroom, the
  // master's own balcony) or off LIVING's front edge (extra balconies).
  // Anything fanning out "back" of a bedroom sits in a Y-band that's
  // ENTIRELY BEHIND that bedroom's own row - it never overlaps the
  // NEXT bedroom in the row (which sits in the SAME Y-band as the bedroom
  // itself, not behind it), so there's no equivalent "something important
  // sits right after it" risk to guard against here the way there is for
  // living's right/left sides. Bounding this anyway was tried and found
  // to be actively WRONG: it broke the very case this pass's second
  // finding needed fixed (an en-suite bathroom and that same bedroom's own
  // balcony, both "back" of one bedroom) - their combined width can
  // legitimately exceed a single bedroom's own width without colliding
  // with anything, so wrapping them apart (like a bounded "right"/"left"
  // stack has to) would have put the balcony directly behind the
  // BATHROOM instead of behind the BEDROOM, failing the task's own
  // explicit requirement that balcony_0 end up genuinely touching
  // bedroom_0, not just something in its general vicinity.
  const maxPerpExtentFor = (target, side) =>
    side === "right" || side === "left" ? target.h / 2 : Infinity;

  // Computes a position for `size` immediately next to `target`'s box, on
  // the given side, offset along the perpendicular fan-out axis by
  // `perpOffset` and, once a column has wrapped (see claimPosition above),
  // pushed an additional `alongOffset` further out along the SAME side's
  // own direction (both real unit-space lengths, not slot counts).
  const placeAdjacent = (target, size, side, perpOffset, alongOffset = 0) => {
    switch (side) {
      case "right":
        return {
          cx: target.cx + target.w / 2 + SEED_GAP + size.w / 2 + alongOffset,
          cy: target.cy + perpOffset,
        };
      case "left":
        return {
          cx: target.cx - target.w / 2 - SEED_GAP - size.w / 2 - alongOffset,
          cy: target.cy + perpOffset,
        };
      case "back": // further from the plot's front edge (larger y)
        return {
          cx: target.cx + perpOffset,
          cy: target.cy + target.h / 2 + SEED_GAP + size.h / 2 + alongOffset,
        };
      case "front": // toward the plot's front edge (smaller y)
        return {
          cx: target.cx + perpOffset,
          cy: target.cy - target.h / 2 - SEED_GAP - size.h / 2 - alongOffset,
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
  // TWO exceptions to that strict ordering, both added in this pass and
  // both explained in full where they happen below:
  //
  //  1. hallway isn't placed "beside its attach target" the way every
  //     lower-priority block is - it has to be placed right after the
  //     bedroom row, because its own geometry (width) is DERIVED from the
  //     bedroom row's actual extent, and every bedroom's attach target
  //     (attachMap.js's bedroom -> hallway rule) needs it to already exist
  //     as a real, correctly-sized box.
  //
  //  2. bathroom is placed in TWO PASSES, one before the bedroom row and
  //     one after (see placeBathrooms() below) - a SHARED "hall" bathroom
  //     (target = living) doesn't need bedrooms to exist yet, and
  //     critically its own placement can reach PAST living's own bottom
  //     edge into the space directly behind living, which is exactly
  //     where the bedroom row/hallway need to start. Deciding where the
  //     bedroom row starts BEFORE a shared bathroom stack has claimed its
  //     real extent there was a genuine bug this pass reproduced and
  //     fixed: with the OLD single-pass ordering, 2 shared "hall"
  //     bathrooms stacked on living's right side already reached almost
  //     exactly as far down as living's own zone was assumed to end (this
  //     was ALREADY a hairline-tight fit even before hallway existed - the
  //     old bedroom row's front edge and this stack's reach differed by
  //     under 0.001 units), and the shared bathrooms could dodge sideways
  //     around a single narrow bedroom's edge to avoid overlapping it. The
  //     new hallway spans the FULL bedroom row's width, closing off that
  //     sideways dodge entirely - so the exact same near-miss geometry
  //     that used to just barely work now produces a real, unresolvable
  //     seed-time overlap between the bathroom stack and the hallway,
  //     which the solver's collision safety net (having no awareness of
  //     attach relationships) then resolved by cascading the bathroom far
  //     enough away from living to break its door-adjacency entirely -
  //     reproduced directly: the demo's 3-bedroom/2-bathroom scenario left
  //     bathroom_1 with NO real shared wall with living at all
  //     (doors.js's own stricter self-check caught it; validate.js's
  //     existing checks did not, since none of them check a non-en-suite
  //     bathroom's adjacency to living). Fixed by placing shared-target
  //     bathrooms (and kitchen/storage, which have the same "stacks off
  //     living and could in principle reach past it" shape) BEFORE
  //     deciding where the bedroom row starts, and having the bedroom
  //     row/hallway start below EVERYTHING actually placed near living by
  //     that point - not just living's own footprint - the same principle
  //     already used for extra living rooms just below.

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
  for (const room of byType.living ?? []) {
    const size = sizeOf(room.type);
    let cx;
    let cy;
    if (!mainLivingBox) {
      cx = livingCursorX + size.w / 2;
      cy = size.h / 2; // top edge sits exactly at y = 0, the plot's front boundary
      livingCursorX += size.w + SEED_GAP;
    } else {
      const { perpOffset, alongOffset, chainParentId } = claimPosition(
        `${mainLivingBox.id}:back`,
        size.w,
        size.h,
        mainLivingBox.w / 2,
        room.id
      );
      if (chainParentId) resolvedAttachMap[room.id] = chainParentId;
      ({ cx, cy } = placeAdjacent(mainLivingBox, size, "back", perpOffset, alongOffset));
    }
    const box = { id: room.id, type: room.type, cx, cy, w: size.w, h: size.h };
    placed.set(room.id, box);
    if (!mainLivingBox) mainLivingBox = box;
    livingRowBottomY = Math.max(livingRowBottomY, cy + size.h / 2);
  }

  // --- bathroom: parked immediately beside whatever it attaches to ---
  // Extracted into a function and called in TWO PASSES (see the ordering
  // comment above for the full reasoning): once right below, for SHARED
  // "hall" bathrooms (target = living, which already exists); and once
  // again after the bedroom row/hallway are placed, for EN-SUITE
  // bathrooms (target = a bedroom, which doesn't exist yet on the first
  // call). `if (placed.has(...))` guards against re-processing a bathroom
  // a previous pass already placed.
  const placeBathrooms = () => {
    for (const room of byType.bathroom ?? []) {
      if (placed.has(room.id)) continue;
      const size = sizeOf(room.type);
      const targetId = attachMap[room.id];
      const target = placed.get(targetId);
      // Not on record YET (an en-suite bathroom, on the first/pre-bedroom
      // call) - not an error, just this bathroom's turn hasn't come yet;
      // the second call picks it up once its bedroom exists.
      if (!target) continue;
      // An en-suite bathroom (target is a bedroom) can't safely go on the
      // bedroom's "right" side the way a shared bathroom off living can:
      // bedrooms are laid out as a contiguous row with only a small
      // SEED_GAP between them, so the very next bedroom in the row is
      // usually already sitting exactly where "right of this bedroom"
      // would land, which would seed a collision directly onto a
      // HIGH-priority bedroom (85) rather than a low-priority room that's
      // expected to yield. The space directly BEHIND a bedroom (further
      // into the plot, away from living) is still empty at this point -
      // so an en-suite bathroom goes there instead. A shared hall bathroom
      // (target is living) keeps using "right", since living's right side
      // has no such neighbour problem.
      const side = target.type === "bedroom" ? "back" : "right";
      // Keyed by target+side (not target+"bathroom") - see the big
      // comment on claimedColumn/claimPosition above: this general
      // mechanism is what lets several shared "hall" bathrooms (all
      // target=living, side="right") fan out safely, and it's also half of
      // the original en-suite-bathroom/balcony fix (the other half is
      // giving balcony a different side entirely - see the balcony block
      // far below). maxPerpExtentFor bounds how far a shared-hall bathroom
      // stack can reach down living's right side before wrapping into a
      // new column, which matters now that a hallway sits directly behind
      // living.
      const extent = fanOutExtent(size, side);
      const { perpOffset, alongOffset, chainParentId } = claimPosition(
        `${targetId}:${side}`,
        extent.perp,
        extent.along,
        maxPerpExtentFor(target, side),
        room.id
      );
      // If this bathroom got wrapped into a second (or later) fan-out
      // column, chainParentId points at whichever sibling bathroom it's
      // actually touching - override its EFFECTIVE target so solveLayout/
      // doors.js/validateLayout all treat that real, physical wall as the
      // relationship to satisfy, instead of a nominal "-> living" label
      // that no longer corresponds to any real wall this bathroom has. See
      // the big comment on claimPosition above for the full reasoning; this
      // is what fixes the sealed shared-bathroom defect (STATUS.md Day 7-8
      // reviewer close-out).
      if (chainParentId) resolvedAttachMap[room.id] = chainParentId;
      const { cx, cy } = placeAdjacent(target, size, side, perpOffset, alongOffset);
      placed.set(room.id, { id: room.id, type: room.type, cx, cy, w: size.w, h: size.h });
    }
  };
  placeBathrooms(); // pass 1: shared "hall" bathrooms only (see above)

  // --- kitchen: beside living (opposite side from bathrooms, so they don't compete for the same space) ---
  // Placed here, before the bedroom row/hallway, purely to match
  // placeBathrooms' pass-1 ordering above (kitchen's target, living,
  // already exists) - not because kitchen itself needs special handling:
  // claimPosition's column-wrapping (see the big comment above) already
  // keeps its reach bounded to living's own footprint on its own, the same
  // as every other "right"/"left" placement in this file.
  for (const room of byType.kitchen ?? []) {
    const size = sizeOf(room.type);
    const targetId = attachMap[room.id];
    const target = placed.get(targetId);
    if (!target) continue;
    const extent = fanOutExtent(size, "left");
    const { perpOffset, alongOffset, chainParentId } = claimPosition(
      `${targetId}:left`,
      extent.perp,
      extent.along,
      maxPerpExtentFor(target, "left"),
      room.id
    );
    // See the bathroom block above for the full reasoning - kitchen shares
    // the exact same claimPosition mechanism, so it needs the exact same
    // correction if it's ever wrapped (in practice a rare case, since
    // roomProgram.js only ever produces at most one kitchen today, but this
    // stays generic rather than special-cased per room type, per this
    // pass's own requirement).
    if (chainParentId) resolvedAttachMap[room.id] = chainParentId;
    const { cx, cy } = placeAdjacent(target, size, "left", perpOffset, alongOffset);
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
    // that's where shared "hall" bathrooms stack up (see placeBathrooms
    // above) - piling storage into that same corridor on top of however
    // many bathrooms are already queued there is exactly what produced
    // seed-time collisions when testing programs with several bathrooms and
    // no kitchen.
    const side = "left";
    const extent = fanOutExtent(size, side);
    const { perpOffset, alongOffset, chainParentId } = claimPosition(
      `${targetId}:${side}`,
      extent.perp,
      extent.along,
      maxPerpExtentFor(target, side),
      room.id
    );
    // The exact same defect and fix as the bathroom block above, and the
    // one STATUS.md's reviewer measured as unconditionally sealing
    // storage_1 in every single "2 storage rooms" request: a second (or
    // later) storage room wrapped into its own fan-out column only
    // genuinely touches the storage room beside it, not its nominal
    // "-> kitchen"/"-> living" label.
    if (chainParentId) resolvedAttachMap[room.id] = chainParentId;
    const { cx, cy } = placeAdjacent(target, size, side, perpOffset, alongOffset);
    placed.set(room.id, { id: room.id, type: room.type, cx, cy, w: size.w, h: size.h });
  }

  // Note: livingRowBottomY is NOT widened here to account for the shared
  // bathroom/kitchen/storage stacks just placed above, unlike the "extra
  // living rooms" case below (which genuinely does extend it). That's a
  // deliberate difference, not an oversight: claimPosition's column
  // wrapping (see the big comment on it above) already GUARANTEES every
  // "right"/"left" placement's far edge stays within `maxPerpExtentFor`
  // (the target's own half-height) of the target's own centre - i.e.
  // within living's own footprint - so nothing placed via placeBathrooms/
  // the kitchen/storage blocks above can ever reach past living's own
  // bottom edge in the first place. living's own footprint (set in the
  // living block above) is already a correct, sufficient bound for where
  // the bedroom row/hallway need to start.
  //
  // (An earlier version of this fix tried the OPPOSITE approach - widening
  // livingRowBottomY to match wherever the bathroom stack actually landed
  // - and that turned out to be wrong: it moved the hallway's own front
  // edge away from living's, breaking the hallway<->living wall EVERYWHERE
  // along its width, not just near the bathroom, since a single
  // rectangular hallway can't touch living at one y for part of its width
  // while dodging a stack at a different y for the rest. Bounding the
  // stack itself, so it never needs dodging, is the only fix that keeps
  // both relationships genuinely satisfied at once.)

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
  // THE ACTUAL FIX for this pass's core finding (see the big comment at the
  // top of this file, and attachMap.js's new bedroom -> hallway rule): a
  // hallway is the shared connector that borders living on one side and the
  // WHOLE bedroom row on the other, so every individual bedroom genuinely
  // shares a wall segment with it - not just one specific bedroom the way
  // an en-suite bathroom or balcony attaches to only ONE. "Genuinely" is
  // checked BY CONSTRUCTION below (matching y-coordinates exactly, not
  // "close enough"), not left to the solver/WALL_SNAP to paper over later -
  // that's precisely the kind of gap that let the balcony/en-suite
  // collision (fixed separately below) go undetected until doors.js's own
  // stricter geometric self-check finally surfaced it.
  //
  // Computed from the bedroom boxes ACTUALLY placed just above (their real
  // cx/cy/w/h), not from bedroomCursorX bookkeeping - "computed from
  // wherever bedrooms actually end up during seeding", per this pass's own
  // instructions, so this stays correct even if bedroom sizing/placement
  // ever changes independently of this block.
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
    // first/leftmost bedroom in the row, never any other bedroom) goes to
    // its LEFT side, not "back" - a deliberate choice, not the first one
    // tried. "back" was tried first (matching en-suite bathroom's own
    // placement) and reproduces the exact collision this section exists to
    // fix: bathroom_0 and balcony_0 both fan out "back" of bedroom_0, and
    // their COMBINED width (typically ~0.40-0.43 units for real
    // dataset-derived sizes) can genuinely exceed one bedroom's own width
    // (~0.39 units) - not a bug, just real dataset-derived room sizes not
    // leaving quite enough room for two "back of one bedroom" occupants
    // side by side. Bounding that fan-out to avoid the collision (the same
    // fix applied to living's right/left sides, where it's genuinely
    // needed - see maxPerpExtentFor's comment) just moves the problem: it
    // stacks balcony_0 BEHIND bathroom_0 instead of beside it, so balcony_0
    // ends up touching bathroom_0, never bedroom_0 - failing this pass's
    // own explicit requirement. Leaving it UNBOUNDED instead (matching
    // "back"'s own lack of a bound) fixes THAT, but then balcony_0's
    // sideways reach lands squarely in bedroom_1's own "back" zone (its
    // en-suite bathroom_1, in the exact reproduction case) - a genuine,
    // reproduced collision between two DIFFERENT bedrooms' own attached
    // rooms, which the solver then resolves by dragging balcony_0 away
    // from bedroom_0 entirely (net: the exact same broken outcome, just
    // reached a different way).
    //
    // bedroom_0's LEFT side sidesteps both problems at once: bedroom_0 is
    // ALWAYS the row's leftmost bedroom (seedLayout's bedroom block starts
    // bedroomCursorX at 0 and places typeIndex 0 first), so x < 0 in its
    // own Y-band is guaranteed empty - nothing else in this file ever
    // places anything there (kitchen/storage sit near LIVING's own Y-band,
    // well in front of the bedroom row, not behind it). Balcony can sit
    // directly beside bedroom_0 there, genuinely touching it, without
    // competing with bathroom_0's own "back" placement OR reaching into
    // any sibling bedroom's territory.
    const side = target.type === "bedroom" ? "left" : "front";
    const extent = fanOutExtent(size, side);
    const { perpOffset, alongOffset, chainParentId } = claimPosition(
      `${targetId}:${side}`,
      extent.perp,
      extent.along,
      maxPerpExtentFor(target, side),
      room.id
    );
    // "front"/"left" both have an unbounded maxPerpExtentFor (Infinity - see
    // that function's own comment), so in practice this never actually
    // wraps and chainParentId always comes back null - included anyway so
    // balcony isn't a silent exception to the general mechanism if that
    // ever changes (e.g. if living's exterior edge one day gets bounded
    // too).
    if (chainParentId) resolvedAttachMap[room.id] = chainParentId;
    const { cx, cy } = placeAdjacent(target, size, side, perpOffset, alongOffset);
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
  // internally. `attachMap` is the resolved/chained copy built up above -
  // see this function's own JSDoc for why callers should use THIS one, not
  // the plain input attachMap, for every stage from here on.
  return { rooms: rooms.map((room) => placed.get(room.id)), attachMap: resolvedAttachMap };
}
