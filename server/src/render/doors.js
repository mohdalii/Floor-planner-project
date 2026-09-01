// doors.js
//
// Cuts door openings into the wall network buildWallNetwork() produced, one
// per relationship in the rule engine's attach-map (bedroom<->bathroom,
// kitchen->living, ...), plus one special-cased front door in the exterior
// wall. This is the second half of the "connected walls, not floating
// boxes" fix: it's not enough for two rooms to share a wall line (that's
// wallNetwork.js's job) - the whole point of a shared wall is that there's
// a door in it, so a person could actually walk between the two rooms.
//
// Ported (concept only) from
// D:\ai-floor-planner\python\app\floor_generator\cad_render.py's
// shared_edge / place_interior_doors / place_front_door / add_door_cut,
// working from OUR room shape (meter-space boxes from wallNetwork.js's
// roomsToMeters, not that project's [0,1]-normalised model output) and OUR
// attachMap.js output (a plain { roomId: targetRoomId } object, not a
// PyTorch-tensor-based map).

import { WALL_SNAP } from "./wallNetwork.js";

// A standard interior residential door width. Real architecture knowledge,
// not something derived from this project's data - same reasoning as
// wallNetwork.js's wall-thickness constants.
export const DOOR_W = 0.90; // m

// Keeps a cut interior door from opening right where two walls meet (a door
// hinged exactly at a corner has nowhere sensible to swing, and reads as a
// drafting mistake in a real architectural drawing). Also a standard
// architectural clearance figure, not tuned to this project's geometry.
const CORNER_CLEAR = 0.28; // m
// Same idea, applied to the front door against the building's own outer
// corners (a slightly larger clearance, since an exterior corner is a more
// structurally important junction than an interior partition corner).
const EXT_CORNER_CLEAR = 0.50; // m

// Two edges from different rooms only count as a genuine "shared wall"
// worth putting a door in if they actually overlap by a meaningful amount
// along the wall - a corner where two rooms merely touch at a point (near-
// zero overlap) isn't a wall two rooms share, it's a coincidence of where
// their corners happen to land.
const MIN_SHARED_SPAN = 0.30; // m

// A cut that gets clamped down (by corner clearance, or by the wall
// segment simply being short) to less than this isn't worth drawing as a
// door - it wouldn't be wide enough to walk through in real life.
const MIN_DOOR_GAP = 0.30; // m
// Extra margin kept between a cut's own edges and the wall segment's true
// endpoints, so a door opening never touches (and looks like it merges
// with) the very end of a wall.
const CUT_MARGIN = 0.05; // m

// ---------------------------------------------------------------------
// shared_edge equivalent: given two room boxes (in real metres), find the
// specific wall they actually share - not just "some wall at the right
// x/y coordinate", but the exact edge-to-edge pairing between THESE two
// rooms. Checks both directions for each axis (a's right against b's left,
// AND a's left against b's right; same for top/bottom) because attachMap.js
// doesn't record which side of which room is which - a bathroom could have
// ended up to the left OR right of its bedroom depending on how the solver
// settled it.
//
// Returns the closest-matching candidate (smallest gap) if more than one
// axis produces a plausible shared edge, since the smallest gap is the most
// likely to be the wall the two rooms actually meant to share.
function sharedEdge(a, b) {
  const candidates = [];

  for (const [xa, xb] of [
    [a.x2, b.x1],
    [a.x1, b.x2],
  ]) {
    const gap = Math.abs(xa - xb);
    const overlapStart = Math.max(a.y1, b.y1);
    const overlapEnd = Math.min(a.y2, b.y2);
    if (gap <= WALL_SNAP && overlapEnd - overlapStart > MIN_SHARED_SPAN) {
      candidates.push({ orientation: "v", coord: (xa + xb) / 2, start: overlapStart, end: overlapEnd, gap });
    }
  }

  for (const [ya, yb] of [
    [a.y2, b.y1],
    [a.y1, b.y2],
  ]) {
    const gap = Math.abs(ya - yb);
    const overlapStart = Math.max(a.x1, b.x1);
    const overlapEnd = Math.min(a.x2, b.x2);
    if (gap <= WALL_SNAP && overlapEnd - overlapStart > MIN_SHARED_SPAN) {
      candidates.push({ orientation: "h", coord: (ya + yb) / 2, start: overlapStart, end: overlapEnd, gap });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((p, q) => p.gap - q.gap);
  return candidates[0];
}

// Finds which already-built wall segment (from buildWallNetwork) a given
// shared-edge span actually lies on - matched by orientation, by having a
// coordinate within WALL_SNAP of the requested one (the same tolerance used
// to cluster edges into that segment in the first place), and by actually
// spanning the point we want to cut at.
function findSegment(segments, orientation, coord, at) {
  let best = null;
  let bestDistance = Infinity;
  for (const seg of segments) {
    if (seg.orientation !== orientation) continue;
    const distance = Math.abs(seg.coord - coord);
    if (distance > WALL_SNAP) continue;
    if (at < seg.start - 1e-6 || at > seg.end + 1e-6) continue;
    if (distance < bestDistance) {
      best = seg;
      bestDistance = distance;
    }
  }
  return best;
}

// Cuts a door-width gap into `seg`, centred on `gapCenter`, clamped so it
// never reaches the segment's own true endpoints (CUT_MARGIN) - that's what
// keeps interior doors away from wall corners/junctions per the milestone
// requirement. `inwardPoint` is whichever room's centre the door should
// swing INTO (see placeInteriorDoors/placeFrontDoor below for how that's
// chosen) - it only affects the SIGN of the cut's inwardDx/inwardDy, which
// svgRenderer.js later uses to know which side of the wall to draw the
// swing symbol on.
//
// Returns true if a cut was actually added, false if it had to be skipped
// (the available space clamped down below MIN_DOOR_GAP) - demo.js's
// self-checks use this to confirm every relationship that SHOULD get a
// door actually got one, rather than silently disappearing.
function addDoorCut(seg, gapCenter, gapHalf, inwardPoint) {
  const gapStart = Math.max(seg.start + CUT_MARGIN, gapCenter - gapHalf);
  const gapEnd = Math.min(seg.end - CUT_MARGIN, gapCenter + gapHalf);
  if (gapEnd - gapStart < MIN_DOOR_GAP) return false;

  let inwardDx = 0;
  let inwardDy = 0;
  if (seg.orientation === "v") {
    // A vertical wall's "inward" side is purely left/right of its x coordinate.
    inwardDx = inwardPoint.x >= seg.coord ? 1 : -1;
  } else {
    // A horizontal wall's "inward" side is purely above/below its y coordinate.
    inwardDy = inwardPoint.y >= seg.coord ? 1 : -1;
  }

  seg.cuts.push({ gapStart, gapEnd, inwardDx, inwardDy });
  return true;
}

// ---------------------------------------------------------------------
// place_interior_doors equivalent
// ---------------------------------------------------------------------

// Cuts one door per attachMap relationship (excluding front_door, which is
// handled separately below - it isn't a walled room with two interior
// neighbours, it's a marker for an exterior-wall opening). For each
// relationship, this finds the ACTUAL shared edge between those two
// SPECIFIC rooms (not just any wall sitting at a plausible coordinate) and
// cuts a door-width gap into whichever built wall segment that edge lies
// on, centred on the shared span and clamped away from the segment's own
// corners.
function placeInteriorDoors(network, attachMap) {
  const { interiorWalls, meterRooms } = network;
  const byId = new Map(meterRooms.map((room) => [room.id, room]));

  const placed = [];
  const skipped = [];

  for (const [srcId, targetId] of Object.entries(attachMap)) {
    const a = byId.get(srcId);
    const b = byId.get(targetId);

    if (!a || !b) {
      skipped.push({ srcId, targetId, reason: "attach-map referenced a room that isn't in the solved layout" });
      continue;
    }
    // front_door's own relationship (front_door_0 -> living_0) is an
    // exterior-wall door, not an interior one - place_front_door handles it.
    if (a.type === "front_door" || b.type === "front_door") continue;

    const edge = sharedEdge(a, b);
    if (!edge) {
      skipped.push({ srcId, targetId, reason: "no shared wall found between these two rooms within WALL_SNAP" });
      continue;
    }

    const seg = findSegment(interiorWalls, edge.orientation, edge.coord, (edge.start + edge.end) / 2);
    if (!seg) {
      skipped.push({ srcId, targetId, reason: "shared edge didn't match any built wall segment" });
      continue;
    }

    // Clamp the door's centre away from this wall segment's own corners.
    // If the segment is too short to keep both a left AND right clearance
    // (a short wall between two small rooms), fall back to using the whole
    // segment rather than leaving no valid placement at all - matches the
    // reference implementation's same fallback.
    const clearLo = seg.start + CORNER_CLEAR;
    const clearHi = seg.end - CORNER_CLEAR;
    const lo = clearHi > clearLo ? clearLo : seg.start;
    const hi = clearHi > clearLo ? clearHi : seg.end;
    const mid = Math.min(Math.max((edge.start + edge.end) / 2, lo), hi);

    // Don't let the door eat more than 70% of a short wall segment - a
    // "door" that's nearly the whole wall isn't a door opening any more,
    // it's just an open archway spanning the entire shared edge.
    const gapHalf = Math.min(DOOR_W, (seg.end - seg.start) * 0.7) / 2;

    // Swing the door INTO the attach target's room (b) - matches the
    // reference implementation's convention (the door opens toward
    // whichever room is the "target" of the relationship, e.g. into the
    // bathroom from the bedroom side, into living from the kitchen side).
    const cut = addDoorCut(seg, mid, gapHalf, { x: b.cx, y: b.cy });
    if (cut) {
      placed.push({ srcId, targetId });
    } else {
      skipped.push({ srcId, targetId, reason: "cut clamped below the minimum usable door width" });
    }
  }

  return { placed, skipped };
}

// ---------------------------------------------------------------------
// place_front_door equivalent
// ---------------------------------------------------------------------

// The front door isn't a room with two neighbours the way every other
// attach-map relationship is - it's a small marker box seeding.js places
// right at the plot's front edge (y=0), next to living. This works out
// which of the FOUR exterior walls it's actually closest to, then cuts a
// standard-width door into that specific exterior wall segment, clamped
// away from the building's own corners the same way interior doors are
// clamped away from junctions.
function placeFrontDoor(network) {
  const { exteriorWalls, meterRooms, W, D } = network;
  const frontDoor = meterRooms.find((room) => room.type === "front_door");
  if (!frontDoor) return false; // buildRoomProgram() always adds exactly one, but stay defensive

  const { cx, cy } = frontDoor;
  // How far the front door marker sits from each of the four plot edges -
  // whichever is smallest is the side it belongs on.
  const distanceToSide = { left: cx, right: W - cx, front: cy, back: D - cy };
  let side = "front";
  let best = Infinity;
  for (const [candidateSide, distance] of Object.entries(distanceToSide)) {
    if (distance < best) {
      best = distance;
      side = candidateSide;
    }
  }

  // A real front door is a standard width regardless of how big or small
  // the seeded marker box happened to be - the marker's own size only ever
  // mattered for figuring out ITS position, not for sizing the actual cut.
  const gapHalf = DOOR_W / 2;
  // Always swing the front door INTO the house (toward the plot's own
  // centre), never outward onto the street.
  const inwardPoint = { x: W / 2, y: D / 2 };

  let seg;
  let mid;
  if (side === "left" || side === "right") {
    const coord = side === "left" ? 0 : W;
    seg = exteriorWalls.find((s) => s.orientation === "v" && Math.abs(s.coord - coord) < 1e-6);
    const clearLo = seg.start + EXT_CORNER_CLEAR;
    const clearHi = seg.end - EXT_CORNER_CLEAR;
    const lo = clearHi > clearLo ? clearLo : seg.start;
    const hi = clearHi > clearLo ? clearHi : seg.end;
    mid = Math.min(Math.max(cy, lo), hi);
  } else {
    const coord = side === "front" ? 0 : D;
    seg = exteriorWalls.find((s) => s.orientation === "h" && Math.abs(s.coord - coord) < 1e-6);
    const clearLo = seg.start + EXT_CORNER_CLEAR;
    const clearHi = seg.end - EXT_CORNER_CLEAR;
    const lo = clearHi > clearLo ? clearLo : seg.start;
    const hi = clearHi > clearLo ? clearHi : seg.end;
    mid = Math.min(Math.max(cx, lo), hi);
  }

  return addDoorCut(seg, mid, gapHalf, inwardPoint);
}

// ---------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------

/**
 * Cut door openings into a wall network, mutating each affected segment's
 * `.cuts` array in place (segments are plain objects created fresh by
 * buildWallNetwork() for this one render, so mutating them here is safe -
 * nothing else holds a reference to them).
 *
 * @param {ReturnType<import("./wallNetwork.js").buildWallNetwork>} network
 * @param {Object<string, string>} attachMap - roomId -> targetRoomId, from buildAttachMap().
 * @returns {{
 *   interiorDoorsPlaced: Array<{srcId: string, targetId: string}>,
 *   interiorDoorsSkipped: Array<{srcId: string, targetId: string, reason: string}>,
 *   frontDoorPlaced: boolean,
 * }}
 *   Diagnostics, not just a side effect - demo.js's self-checks assert
 *   `interiorDoorsSkipped` is empty and `frontDoorPlaced` is true, i.e.
 *   that every attach-map relationship really did get an actual door cut,
 *   not just that this function ran without throwing.
 */
export function placeDoors(network, attachMap) {
  const { placed, skipped } = placeInteriorDoors(network, attachMap);
  const frontDoorPlaced = placeFrontDoor(network);

  return {
    interiorDoorsPlaced: placed,
    interiorDoorsSkipped: skipped,
    frontDoorPlaced,
  };
}

// Exported purely so demo.js's self-checks can independently re-derive
// "what SHOULD the shared edge between these two rooms be" using the same
// well-tested geometry function this file already relies on, rather than
// re-implementing the same logic a second time just for verification.
export { sharedEdge, findSegment };
