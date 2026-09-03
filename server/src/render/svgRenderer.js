// svgRenderer.js
//
// Turns a solved layout into a complete CAD-style architectural line
// drawing: filled black walls (with door openings actually cut out of
// them, not overlaid on top), door swing symbols, room labels + dimension
// strings, and overall building dimension lines - all black-on-white, no
// room fill colour. This is the direct fix for the visual complaint that
// started this milestone: the old preview (.preview/sample_floor_plan.svg,
// a throwaway scratch script's output, gitignored and never committed)
// drew flat-coloured rectangles, one per room, floating with gaps between
// them. This file draws WALLS - built by wallNetwork.js, cut by doors.js -
// not room boxes.
//
// Ported (concept and visual language only - the source renders through
// matplotlib, a completely different drawing stack) from
// D:\ai-floor-planner\python\app\floor_generator\cad_render.py's
// render_cad / draw_wall_segment / draw_door_symbol / draw_room_labels /
// draw_building_dimensions. Furniture icons from that file are deliberately
// NOT ported here - several of the user's own reference images are plain
// line drawings with no furniture at all, and the milestone's actual ask
// (connected walls + doors + labels + dimensions) doesn't need them. Left
// as documented future polish, not something this pass silently dropped.

import { buildWallNetwork } from "./wallNetwork.js";
import { placeDoors } from "./doors.js";

// ---------------------------------------------------------------------
// Layout constants for the SVG canvas itself (pixels / metres-to-pixels).
// These only affect how big the drawing looks, never the underlying
// geometry - the wall network and door cuts are already fully decided in
// real metres by the time this file touches them.
// ---------------------------------------------------------------------

// Extra space (in metres) reserved around the building footprint for the
// building dimension lines and room labels near the edges. Top and left
// get more room than bottom and right because that's where this renderer
// draws the two overall dimension lines (see buildingDimensionsSvg below) -
// ganging both dimension lines off one corner (top-left here) is the same
// convention the reference file uses (bottom-left, in its own coordinate
// convention), just adapted to this project's y-down/no-flip drawing.
const PAD_LEFT_M = 1.6;
const PAD_TOP_M = 1.7; // extra room for the title text as well as the width dimension line
const PAD_RIGHT_M = 0.7;
const PAD_BOTTOM_M = 0.7;

// The renderer picks a metres-to-pixels scale that fits the whole padded
// drawing inside a reasonable on-screen size, clamped so a tiny studio
// layout doesn't render microscopically and a huge layout doesn't render
// as an unusably large image.
const TARGET_MAX_PX = 1000;
const MIN_PX_PER_M = 20;
const MAX_PX_PER_M = 80;

const TYPE_LABELS = {
  bedroom: "BEDROOM",
  bathroom: "BATHROOM",
  kitchen: "KITCHEN",
  living: "LIVING ROOM",
  balcony: "BALCONY",
  storage: "STORAGE",
};

// ---------------------------------------------------------------------
// XML/SVG text escaping - every piece of text this renderer draws is
// either a fixed label ("BEDROOM") or a formatted number, but escaping is
// cheap insurance against a room `type` string ever containing a character
// SVG's XML syntax would choke on.
// ---------------------------------------------------------------------
function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------
// Wall drawing
// ---------------------------------------------------------------------

// Splits a wall segment into the solid "pieces" left over once its door
// cuts are removed - e.g. a 5m wall with one door cut in the middle becomes
// two solid pieces either side of the opening. Mirrors the reference
// file's draw_wall_segment piece computation exactly (sort cuts, walk left
// to right accumulating solid stretches between them).
function wallPieces(seg) {
  const cuts = [...seg.cuts].sort((a, b) => a.gapStart - b.gapStart);
  const pieces = [];
  let cursor = seg.start;
  for (const cut of cuts) {
    if (cut.gapStart > cursor) pieces.push([cursor, cut.gapStart]);
    cursor = Math.max(cursor, cut.gapEnd);
  }
  if (cursor < seg.end) pieces.push([cursor, seg.end]);
  // Defensive fallback for the degenerate case where cuts happened to
  // consume the segment's entire length (cursor lands exactly on seg.end) -
  // draw the whole thing rather than nothing. Matches the reference file's
  // own fallback for the same edge case.
  if (pieces.length === 0) pieces.push([seg.start, seg.end]);
  return pieces;
}

// Renders one wall segment as one or more filled black <rect> elements (one
// per solid piece from wallPieces above). Each piece's own true endpoints
// (the segment's real start/end, not a piece boundary created by a door
// cut) get padded outward by half the wall's thickness - this is what
// makes two perpendicular walls meet in a clean square corner instead of
// leaving a thin diagonal gap where they should join.
function drawWallSegmentSvg(seg, project) {
  const t = seg.thickness;
  let svg = "";
  for (const [start, end] of wallPieces(seg)) {
    const padStart = Math.abs(start - seg.start) < 1e-6 ? t / 2 : 0;
    const padEnd = Math.abs(end - seg.end) < 1e-6 ? t / 2 : 0;
    const s = start - padStart;
    const e = end + padEnd;
    if (e - s <= 1e-6) continue;

    let xM;
    let yM;
    let wM;
    let hM;
    if (seg.orientation === "v") {
      xM = seg.coord - t / 2;
      yM = s;
      wM = t;
      hM = e - s;
    } else {
      xM = s;
      yM = seg.coord - t / 2;
      wM = e - s;
      hM = t;
    }

    const p0 = project(xM, yM);
    const p1 = project(xM + wM, yM + hM);
    svg += `  <rect x="${p0.x.toFixed(2)}" y="${p0.y.toFixed(2)}" width="${(p1.x - p0.x).toFixed(2)}" height="${(p1.y - p0.y).toFixed(2)}" fill="black" />\n`;
  }
  return svg;
}

// ---------------------------------------------------------------------
// Door swing symbols
// ---------------------------------------------------------------------

// Draws the standard architectural door-opening symbol at every cut in a
// wall segment: a hinge point at one end of the gap, a straight line (the
// door leaf, drawn at its CLOSED length - the gap's own width) swung 90
// degrees off the wall into the room it opens into, and a quarter-circle
// arc tracing the leaf's swing path between "closed, flush with the wall"
// and "open, into the room".
//
// The arc is drawn as a sampled 16-point polyline rather than a single SVG
// elliptical-arc command. This is a deliberate readability choice: getting
// an SVG `A` command's sweep-flag/large-arc-flag right requires reasoning
// about clockwise-vs-counterclockwise in a coordinate system that's
// already y-down, on top of two possible wall orientations - easy to get
// subtly backwards and hard to spot by eye. Sampling points directly along
// the known 90-degree sweep (from the wall-flush angle to the swung-open
// angle, computed with plain atan2) sidesteps that entirely: every point is
// independently just "hinge + radius at this angle", which is simple to
// verify point-by-point and impossible to get flipped.
function drawDoorSymbolsSvg(seg, project) {
  let svg = "";
  for (const cut of seg.cuts) {
    const width = cut.gapEnd - cut.gapStart;
    if (width <= 0) continue;

    // hinge is always the LOWER-coordinate end of the gap; the wall
    // "tangent" direction d always points from the hinge toward the gap's
    // OTHER end (where the door would be if it were standing shut, flush
    // with the wall); the "inward normal" n is perpendicular to the wall,
    // pointing into whichever room this cut was told to swing into (see
    // doors.js's addDoorCut - inwardDx/inwardDy already encode that).
    let hinge;
    let d;
    let n;
    if (seg.orientation === "v") {
      hinge = { x: seg.coord, y: cut.gapStart };
      d = { x: 0, y: 1 };
      n = { x: cut.inwardDx, y: 0 };
    } else {
      hinge = { x: cut.gapStart, y: seg.coord };
      d = { x: 1, y: 0 };
      n = { x: 0, y: cut.inwardDy };
    }

    const leafEnd = { x: hinge.x + n.x * width, y: hinge.y + n.y * width };

    const hingePx = project(hinge.x, hinge.y);
    const leafEndPx = project(leafEnd.x, leafEnd.y);
    svg += `  <line x1="${hingePx.x.toFixed(2)}" y1="${hingePx.y.toFixed(2)}" x2="${leafEndPx.x.toFixed(2)}" y2="${leafEndPx.y.toFixed(2)}" stroke="black" stroke-width="1.4" />\n`;

    // Sweep from the wall-flush angle (angleD) to the swung-open angle
    // (angleN). d and n are always exactly perpendicular by construction
    // (n is a pure left/right or up/down normal to whichever axis d runs
    // along), so this signed difference is always +-90 degrees - never
    // ambiguous about which way to sweep.
    const angleD = (Math.atan2(d.y, d.x) * 180) / Math.PI;
    const angleN = (Math.atan2(n.y, n.x) * 180) / Math.PI;
    let sweep = (angleN - angleD) % 360;
    if (sweep > 180) sweep -= 360;
    if (sweep < -180) sweep += 360;

    const steps = 16;
    const points = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const angleRad = ((angleD + t * sweep) * Math.PI) / 180;
      const pointM = { x: hinge.x + width * Math.cos(angleRad), y: hinge.y + width * Math.sin(angleRad) };
      const pointPx = project(pointM.x, pointM.y);
      points.push(`${pointPx.x.toFixed(2)},${pointPx.y.toFixed(2)}`);
    }
    svg += `  <polyline points="${points.join(" ")}" fill="none" stroke="black" stroke-width="1" />\n`;
  }
  return svg;
}

// ---------------------------------------------------------------------
// Room labels + per-room dimension strings
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// Empirically-measured glyph-width factors (real bug fix, found by
// actually looking at a rendered PNG, not by a geometric self-check).
//
// The room-labelling logic below used to assume every character averages
// 0.58x the font size wide, for BOTH the bold room-name label ("STORAGE")
// AND the plain dimension string ("1.58m x 1.17m") drawn under it. That
// single guessed number was never checked against how a real browser
// actually renders sans-serif text - and it was wrong specifically for
// bold text, which is visibly WIDER per character than 0.58x. The result:
// fitFontSizePx would compute a font size it believed left ~14% of margin
// (fracW = 0.86) inside the room, when the real rendered text was often
// wider than the room itself - e.g. the STORAGE label in the very first
// rendered PNG this project produced, clipped/invisible against the
// exterior wall because the letters actually extended past the room's own
// left edge, straight into the wall's black fill.
//
// Measured directly (same "don't guess, check" standard this codebase
// already uses for WALL_SNAP in wallNetwork.js): rendered every room-label
// word this file actually generates (TYPE_LABELS' values, "MASTER BEDROOM",
// "HALLWAY") plus two representative dimension strings, in a real headless
// Chromium tab, and read back each string's true pixel width via SVG
// `getBBox()` at font-size 16 (bold, matching drawRoomLabelsSvg's label
// text) and 11 (normal weight, matching its dimension text). The measured
// perCharFactor (bbox.width / (text.length * fontSizePx)) ranged from
// 0.611 ("LIVING ROOM", the longest label) to 0.746 ("BEDROOM", the worst
// case) for bold labels, and 0.509-0.524 for the plain dimension strings.
// The two constants below are each set a little ABOVE the worst value this
// project's own real label text actually measured at, not exactly AT it -
// deliberate headroom for cross-platform font-metric variation (a
// different OS/browser's default sans-serif could measure a few percent
// wider), same reasoning WALL_SNAP's own margin above its measured ceiling
// used.
const LABEL_CHAR_W_FACTOR = 0.78; // bold label text - worst measured: BEDROOM at 0.746
const DIM_CHAR_W_FACTOR = 0.56; // plain dimension text - worst measured: 0.524

// Picks a font size (in pixels) that actually fits inside a box of the
// given real-world size, or returns null if even the smallest legible size
// wouldn't fit - the caller uses null to mean "skip this text entirely
// rather than drawing something illegibly small or overflowing the room".
// Ported concept from the reference file's fit_fontsize, adapted to
// genuinely gate on legibility: the reference's own version always clamped
// the result UP to a minimum font size, which made its "is this even
// legible" check permanently true regardless of room size - this version
// instead returns null when the true best-fit size falls below the
// legibility floor, which is what the milestone actually asked for
// ("skipping the dimension text if the room is too small to hold it
// legibly").
function fitFontSizePx(text, boxWM, boxHM, pxPerMeter, { maxFs, minLegibleFs, heightFrac, charWFactor }) {
  if (!text) return null;
  const fracW = 0.86; // leave a little breathing room on either side of the text
  const fitWidth = (boxWM * fracW * pxPerMeter) / Math.max(1, text.length) / charWFactor;
  const fitHeight = boxHM * heightFrac * pxPerMeter;
  const fs = Math.min(maxFs, fitWidth, fitHeight);
  return fs >= minLegibleFs ? fs : null;
}

// Estimated pixel width of `text` rendered at `fontSizePx`, using the same
// per-character factor fitFontSizePx was just given for that same text -
// used to size the opaque background "halo" behind a label (see
// drawTextWithHalo below), not to decide the font size itself. Because
// LABEL_CHAR_W_FACTOR/DIM_CHAR_W_FACTOR above are deliberately set ABOVE
// the worst real width this project's own label text measured, reusing the
// same factor here means the estimated width is also safely on the
// generous side for every shorter/narrower real label - so the halo this
// produces is never narrower than the real glyphs it needs to hide.
function estimateTextWidthPx(text, fontSizePx, charWFactor) {
  return text.length * charWFactor * fontSizePx;
}

// Draws an opaque background rectangle sized to comfortably contain `text`
// at `fontSizePx`, THEN the text itself on top - a "label halo". This is
// the fix for a real visual bug found by looking at a rendered PNG: the
// HALLWAY label sits at the hallway's own centre point, but a narrow
// hallway's bedroom doors all swing their door-symbol arcs INTO the
// hallway (doors.js swings every door into its attach-map TARGET - see
// placeInteriorDoors - and every bedroom's target here IS the hallway), so
// an arc's curve routinely sweeps right through where the label is drawn.
// Room labels were already the LAST thing drawn (see renderFloorPlanSvg -
// they're added to `body` after every wall and door symbol), so in raw SVG
// paint order the text glyphs already sit "on top" - but a glyph is only
// opaque where its own ink is; an arc passing through the WHITESPACE
// between/around letters is still fully visible there, which is what made
// "HALLWAY" read as visually tangled with the arc in the actual rendered
// image despite the z-order already being technically correct. A solid
// background block behind the text (matching the page's own white
// background - see renderFloorPlanSvg's background <rect>) fully occludes
// anything beneath the ENTIRE label area, not just the glyph ink itself,
// which is the standard fix cartography/CAD renderers use for label-over-
// linework legibility.
function drawTextWithHalo(centerXPx, centerYPx, text, fontSizePx, charWFactor, textAttrs) {
  const textWidthPx = estimateTextWidthPx(text, fontSizePx, charWFactor);
  const haloPadXPx = 3;
  const haloPadYPx = 1.5;
  const haloWPx = textWidthPx + haloPadXPx * 2;
  const haloHPx = fontSizePx * 1.15 + haloPadYPx * 2; // 1.15x font size ~ one line's cap-height-to-descender span
  let svg = `  <rect x="${(centerXPx - haloWPx / 2).toFixed(2)}" y="${(centerYPx - haloHPx / 2).toFixed(2)}" width="${haloWPx.toFixed(2)}" height="${haloHPx.toFixed(2)}" fill="white" />\n`;
  svg += `  <text x="${centerXPx.toFixed(2)}" y="${centerYPx.toFixed(2)}" font-size="${fontSizePx.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif"${textAttrs}>${escapeXml(text)}</text>\n`;
  return svg;
}

// Builds the display label for one room ("MASTER BEDROOM", "BATHROOM 2",
// ...). "Master" is bedroom typeIndex 0 - the same convention attachMap.js
// already established for pairing en-suite bathrooms (see its comment: the
// old ML-based project ranked "master" by the trained model's PREDICTED
// size, but our seeding.js gives every bedroom the identical target size,
// so there's no size signal to rank by here; declaration order is what the
// rest of this codebase already uses, and this renderer just reuses it
// rather than inventing a second, different "master" rule based on area
// that wouldn't even find a unique winner given equal-sized bedrooms).
function roomLabel(room, countByType) {
  if (room.type === "bedroom" && room.typeIndex === 0) return "MASTER BEDROOM";
  const base = TYPE_LABELS[room.type] ?? room.type.toUpperCase();
  if (countByType[room.type] > 1) return `${base} ${room.typeIndex + 1}`;
  return base;
}

function drawRoomLabelsSvg(meterRooms, pxPerMeter, project) {
  const countByType = {};
  for (const room of meterRooms) {
    if (room.type === "front_door") continue;
    countByType[room.type] = (countByType[room.type] ?? 0) + 1;
  }

  let svg = "";
  for (const room of meterRooms) {
    // front_door is a door marker, not a labelled room - see wallNetwork.js.
    if (room.type === "front_door") continue;

    const label = roomLabel(room, countByType);
    const dimText = `${room.w.toFixed(2)}m x ${room.h.toFixed(2)}m`;

    const labelFs = fitFontSizePx(label, room.w, room.h, pxPerMeter, {
      maxFs: 16,
      minLegibleFs: 7,
      heightFrac: 0.32,
      charWFactor: LABEL_CHAR_W_FACTOR,
    });
    // Dimension text is only worth attempting in a room that's big enough,
    // in absolute terms, to hold two lines of text at all - a tiny room
    // showing only its label (no dimension string) reads better than a
    // room crammed with two illegible lines.
    const dimFs =
      room.w > 0.9 && room.h > 0.9
        ? fitFontSizePx(dimText, room.w, room.h, pxPerMeter, {
            maxFs: 11,
            minLegibleFs: 6,
            heightFrac: 0.18,
            charWFactor: DIM_CHAR_W_FACTOR,
          })
        : null;

    const centerPx = project(room.cx, room.cy);

    if (labelFs && dimFs) {
      // Stack label above dimension text, both vertically centred on the
      // room's own centre point, with a small gap between the two lines.
      // Each line is pushed away from the shared centre by half its own
      // text height plus half the gap - that's what keeps the gap between
      // the two lines constant regardless of how big either font ends up.
      const labelHalfHeightPx = (labelFs * 1.15) / 2;
      const dimHalfHeightPx = (dimFs * 1.15) / 2;
      const lineGapPx = 2;
      const labelY = centerPx.y - (dimHalfHeightPx + lineGapPx / 2);
      const dimY = centerPx.y + (labelHalfHeightPx + lineGapPx / 2);
      svg += drawTextWithHalo(centerPx.x, labelY, label, labelFs, LABEL_CHAR_W_FACTOR, ' font-weight="bold" fill="black"');
      svg += drawTextWithHalo(centerPx.x, dimY, dimText, dimFs, DIM_CHAR_W_FACTOR, ' fill="#333333"');
    } else if (labelFs) {
      svg += drawTextWithHalo(centerPx.x, centerPx.y, label, labelFs, LABEL_CHAR_W_FACTOR, ' font-weight="bold" fill="black"');
    }
    // If even the label doesn't fit legibly, this room is small enough
    // (e.g. a tiny front_door-adjacent sliver, if one ever slipped through)
    // that no text is drawn for it at all - an empty labelled room reads
    // better than overlapping illegible text.
  }
  return svg;
}

// ---------------------------------------------------------------------
// Overall building dimension lines
// ---------------------------------------------------------------------

// Draws one architectural dimension line: two short extension lines from
// the measured points out to an offset line, tick marks at both ends of
// the offset line, and a centred text label giving the measured distance.
// Ported concept from the reference file's draw_dim_line.
function dimensionLineSvg(p0M, p1M, offsetM, text, tickSizeM, fontSizePx, project) {
  const q0M = { x: p0M.x + offsetM.x, y: p0M.y + offsetM.y };
  const q1M = { x: p1M.x + offsetM.x, y: p1M.y + offsetM.y };

  const p0Px = project(p0M.x, p0M.y);
  const p1Px = project(p1M.x, p1M.y);
  const q0Px = project(q0M.x, q0M.y);
  const q1Px = project(q1M.x, q1M.y);

  let svg = "";
  // Extension lines from the actual building corner out to the offset dimension line.
  svg += `  <line x1="${p0Px.x.toFixed(2)}" y1="${p0Px.y.toFixed(2)}" x2="${q0Px.x.toFixed(2)}" y2="${q0Px.y.toFixed(2)}" stroke="#555555" stroke-width="0.75" />\n`;
  svg += `  <line x1="${p1Px.x.toFixed(2)}" y1="${p1Px.y.toFixed(2)}" x2="${q1Px.x.toFixed(2)}" y2="${q1Px.y.toFixed(2)}" stroke="#555555" stroke-width="0.75" />\n`;
  // The dimension line itself.
  svg += `  <line x1="${q0Px.x.toFixed(2)}" y1="${q0Px.y.toFixed(2)}" x2="${q1Px.x.toFixed(2)}" y2="${q1Px.y.toFixed(2)}" stroke="black" stroke-width="1" />\n`;

  // Tick marks at both ends, perpendicular to the dimension line - the
  // standard architectural alternative to arrowheads.
  const dx = q1M.x - q0M.x;
  const dy = q1M.y - q0M.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const px = -uy; // perpendicular unit vector
  const py = ux;
  for (const qM of [q0M, q1M]) {
    const aM = { x: qM.x - ((ux - px) * tickSizeM) / 2, y: qM.y - ((uy - py) * tickSizeM) / 2 };
    const bM = { x: qM.x + ((ux - px) * tickSizeM) / 2, y: qM.y + ((uy - py) * tickSizeM) / 2 };
    const aPx = project(aM.x, aM.y);
    const bPx = project(bM.x, bM.y);
    svg += `  <line x1="${aPx.x.toFixed(2)}" y1="${aPx.y.toFixed(2)}" x2="${bPx.x.toFixed(2)}" y2="${bPx.y.toFixed(2)}" stroke="black" stroke-width="1.5" />\n`;
  }

  // Label text, centred on the dimension line and nudged a little further
  // out (in the same perpendicular direction as the ticks) so it doesn't
  // sit directly on top of the line itself.
  const midM = { x: (q0M.x + q1M.x) / 2, y: (q0M.y + q1M.y) / 2 };
  const labelOffsetM = tickSizeM * 1.8;
  const labelM = { x: midM.x + px * labelOffsetM, y: midM.y + py * labelOffsetM };
  const labelPx = project(labelM.x, labelM.y);
  // A near-vertical dimension line gets its label rotated 90 degrees so it
  // reads along the line, same as the reference's convention.
  const rotation = Math.abs(ux) >= Math.abs(uy) ? 0 : -90;
  svg += `  <text x="${labelPx.x.toFixed(2)}" y="${labelPx.y.toFixed(2)}" font-size="${fontSizePx.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" fill="black" transform="rotate(${rotation} ${labelPx.x.toFixed(2)} ${labelPx.y.toFixed(2)})">${escapeXml(text)}</text>\n`;

  return svg;
}

// Draws the two overall building dimension lines - width along the front
// edge (offset further outward, i.e. further "up" in this renderer's
// no-flip y convention - see the PAD_* comment above), depth along the
// left edge (offset further left) - both ganged off the same top-left
// corner, the same architectural drafting convention the reference file
// uses off its own bottom-left corner.
function buildingDimensionsSvg(W, D, pxPerMeter, project) {
  const tick = Math.max(0.08, Math.min(Math.min(W, D) * 0.02, 0.22));
  const fontSizePx = Math.max(11, Math.min(16, pxPerMeter * 0.18));
  const offsetForWidthLine = Math.min(0.9, Math.max(0.5, D * 0.07));
  const offsetForDepthLine = Math.min(0.9, Math.max(0.5, W * 0.07));

  let svg = "";
  svg += dimensionLineSvg({ x: 0, y: 0 }, { x: W, y: 0 }, { x: 0, y: -offsetForWidthLine }, `${W.toFixed(2)} m`, tick, fontSizePx, project);
  svg += dimensionLineSvg({ x: 0, y: 0 }, { x: 0, y: D }, { x: -offsetForDepthLine, y: 0 }, `${D.toFixed(2)} m`, tick, fontSizePx, project);
  return svg;
}

// ---------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------

/**
 * Render a solved layout as a complete, self-contained CAD-style SVG
 * string.
 *
 * @param {{
 *   rooms: Array<{id: string, type: string, cx: number, cy: number, w: number, h: number}>,
 *   plot: { widthM: number, depthM: number, areaM2: number },
 * }} solved - solveLayout()'s return value, unchanged.
 * @param {Object<string, string>} attachMap - roomId -> targetRoomId, from buildAttachMap().
 * @returns {string} a complete `<svg>...</svg>` document.
 */
export function renderFloorPlanSvg({ rooms, plot }, attachMap) {
  const network = buildWallNetwork(rooms, plot);
  placeDoors(network, attachMap);

  const { meterRooms, interiorWalls, exteriorWalls, W, D } = network;

  const totalWM = W + PAD_LEFT_M + PAD_RIGHT_M;
  const totalDM = D + PAD_TOP_M + PAD_BOTTOM_M;
  let pxPerMeter = TARGET_MAX_PX / Math.max(totalWM, totalDM);
  pxPerMeter = Math.min(MAX_PX_PER_M, Math.max(MIN_PX_PER_M, pxPerMeter));

  const svgWidthPx = totalWM * pxPerMeter;
  const svgHeightPx = totalDM * pxPerMeter;
  const originXPx = PAD_LEFT_M * pxPerMeter;
  const originYPx = PAD_TOP_M * pxPerMeter;

  // The one place metres become pixels. No axis flip is needed: this
  // renderer keeps the rule engine's own y convention (y=0 is the plot's
  // front/street edge - see seeding.js) as literally "smaller y draws
  // nearer the top of the image" - a consistent, if arbitrary, choice
  // that's simple to reason about (no mirrored coordinates anywhere in
  // this file) and easy to defend as such.
  const project = (xM, yM) => ({ x: originXPx + xM * pxPerMeter, y: originYPx + yM * pxPerMeter });

  let body = "";

  // White background - the room-fill-colour complaint this milestone
  // exists to fix means room INTERIORS get no fill at all (they're simply
  // whatever the page background is); this rect is that background, not a
  // per-room fill.
  body += `  <rect x="0" y="0" width="${svgWidthPx.toFixed(2)}" height="${svgHeightPx.toFixed(2)}" fill="white" />\n`;

  body += `  <text x="${(originXPx + (W * pxPerMeter) / 2).toFixed(2)}" y="${(originYPx * 0.42).toFixed(2)}" font-size="18" font-weight="bold" text-anchor="middle" font-family="sans-serif" fill="black">FLOOR PLAN</text>\n`;

  for (const seg of interiorWalls) body += drawWallSegmentSvg(seg, project);
  for (const seg of exteriorWalls) body += drawWallSegmentSvg(seg, project);
  // Door symbols are drawn AFTER every wall so they always sit visually on
  // top of the wall fills, never hidden underneath one.
  for (const seg of [...interiorWalls, ...exteriorWalls]) body += drawDoorSymbolsSvg(seg, project);

  body += drawRoomLabelsSvg(meterRooms, pxPerMeter, project);
  body += buildingDimensionsSvg(W, D, pxPerMeter, project);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidthPx.toFixed(0)}" height="${svgHeightPx.toFixed(0)}" viewBox="0 0 ${svgWidthPx.toFixed(2)} ${svgHeightPx.toFixed(2)}">\n${body}</svg>\n`;
}
