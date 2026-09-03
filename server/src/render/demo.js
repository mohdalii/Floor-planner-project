// demo.js
//
// A small, directly-runnable smoke test for the CAD-style renderer, the
// same pattern server/src/ruleEngine/demo.js already established: run a
// plausible room program through the FULL pipeline (buildRoomProgram ->
// buildAttachMap -> seedLayout -> solveLayout -> renderFloorPlanSvg),
// write the actual SVG to disk so a human can open and look at it, and
// print a few geometric self-checks a human reading a terminal (rather
// than looking at the rendered image) can still trust.
//
// This is NOT an automated test suite - it's a manual verification tool,
// same as ruleEngine/demo.js's own header explains. A committed batch test
// for the renderer (analogous to ruleEngine/__tests__/batch.test.mjs)
// would be reasonable future work once this milestone's actual visual
// approach is confirmed to be right, not something to add speculatively
// here.
//
// Run from the repo root with:
//   node server/src/render/demo.js

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildRoomProgram } from "../ruleEngine/roomProgram.js";
import { buildAttachMap } from "../ruleEngine/attachMap.js";
import { seedLayout } from "../ruleEngine/seeding.js";
import { solveLayout } from "../ruleEngine/solver.js";

import { buildWallNetwork } from "./wallNetwork.js";
import { placeDoors, sharedEdge, findSegment } from "./doors.js";
import { renderFloorPlanSvg } from "./svgRenderer.js";

// The same plausible mid-size family home ruleEngine/demo.js uses (3
// bedrooms, 2 bathrooms - fewer than bedrooms, so the "shared hall
// bathroom" attach rule is exercised rather than one-to-one en-suites - 1
// kitchen, 1 living room, 1 balcony, 1 storage room, plus the automatic
// front door). Reusing the exact same requirements as the rule engine's
// own demo keeps the two directly comparable - anyone checking this
// output can cross-reference the rule-engine demo's printed room
// positions against this one's rendered walls.
const requirements = {
  bedrooms: 3,
  bathrooms: 2,
  kitchens: 1,
  livingRooms: 1,
  balconies: 1,
  storages: 1,
};

console.log("=== Requirements ===");
console.log(requirements);

const rooms = buildRoomProgram(requirements);
const attachMap = buildAttachMap(rooms);
// seedLayout() returns a RESOLVED attachMap alongside the seeded rooms -
// re-pointed at a genuinely different, valid target for the rare room that
// needs it (see seeding.js's edge-based fan-out design comment, and
// STATUS.md's Day 7-8 entries for why the plain attachMap above isn't safe
// to keep using past this point). Everything downstream (solveLayout,
// buildWallNetwork's door placement, validateLayout) uses this resolved
// version, not the original.
const { rooms: seeded, attachMap: resolvedAttachMap } = seedLayout(rooms, attachMap);
const solved = solveLayout(seeded, resolvedAttachMap);

console.log(`\n=== Solved layout (${solved.rooms.length} rooms) ===`);
console.log(`  plot: ${solved.plot.widthM.toFixed(2)}m x ${solved.plot.depthM.toFixed(2)}m (${solved.plot.areaM2.toFixed(2)} m^2)`);

// ---------------------------------------------------------------------
// Render the actual SVG this milestone is about, and write it to disk.
// ---------------------------------------------------------------------
const svg = renderFloorPlanSvg(solved, resolvedAttachMap);

const thisFileDir = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.join(thisFileDir, "sample_output.svg");
writeFileSync(outputPath, svg, "utf-8");
console.log(`\n=== SVG written ===`);
console.log(`  ${outputPath}`);
console.log(`  ${svg.length} bytes, ${svg.split("\n").length} lines`);

// ---------------------------------------------------------------------
// Self-checks.
//
// This script can't SEE the rendered SVG (no image viewer available here),
// so instead of trusting the picture, it independently re-derives the
// geometry the picture claims to show and checks it directly:
//
//   1. Wall continuity: for every attach-map relationship, is there
//      actually a continuous wall segment (built by buildWallNetwork(),
//      BEFORE any door gets cut into it) covering the full span the two
//      rooms genuinely share? This is the literal "boxes not connected to
//      each other" complaint, checked on the real numbers rather than
//      assumed from the algorithm description.
//   2. Door-cut coverage: did every attach-map relationship - and the
//      front door - actually get a door cut, not just a wall?
//
// A second, independent buildWallNetwork()/placeDoors() run is used here
// purely for these checks (both functions are pure and deterministic, so
// this reproduces bit-identical results to what renderFloorPlanSvg() used
// internally above) rather than having renderFloorPlanSvg() itself return
// internal diagnostics - that keeps its public contract exactly what the
// milestone asked for ("produces a complete SVG string"), with the
// verification machinery living entirely in this demo script instead.
// ---------------------------------------------------------------------
const network = buildWallNetwork(solved.rooms, solved.plot);
const doorReport = placeDoors(network, resolvedAttachMap);

console.log("\n=== Self-check 1: wall continuity ===");
let continuityFailures = 0;
const byId = new Map(network.meterRooms.map((r) => [r.id, r]));
for (const [srcId, targetId] of Object.entries(resolvedAttachMap)) {
  const a = byId.get(srcId);
  const b = byId.get(targetId);
  if (!a || !b || a.type === "front_door" || b.type === "front_door") continue;

  const edge = sharedEdge(a, b);
  if (!edge) {
    console.log(`  FAIL  ${srcId} <-> ${targetId}: no shared edge found at all (rooms may not actually be adjacent)`);
    continuityFailures++;
    continue;
  }
  const seg = findSegment(network.interiorWalls, edge.orientation, edge.coord, (edge.start + edge.end) / 2);
  const covers = seg && seg.start <= edge.start + 1e-6 && seg.end >= edge.end - 1e-6;
  if (covers) {
    console.log(`  PASS  ${srcId} <-> ${targetId}: continuous wall covers the full shared span [${edge.start.toFixed(2)}, ${edge.end.toFixed(2)}]`);
  } else {
    console.log(`  FAIL  ${srcId} <-> ${targetId}: shared span [${edge.start.toFixed(2)}, ${edge.end.toFixed(2)}] is NOT fully covered by a continuous wall segment`);
    continuityFailures++;
  }
}
console.log(`  -> ${continuityFailures === 0 ? "all attach-map relationships have a continuous shared wall" : `${continuityFailures} relationship(s) missing a continuous wall`}`);

console.log("\n=== Self-check 2: door-cut coverage ===");
console.log(`  interior doors placed: ${doorReport.interiorDoorsPlaced.length}`);
for (const { srcId, targetId } of doorReport.interiorDoorsPlaced) {
  console.log(`    PASS  ${srcId} -> ${targetId}`);
}
for (const { srcId, targetId, reason } of doorReport.interiorDoorsSkipped) {
  console.log(`    FAIL  ${srcId} -> ${targetId}: ${reason}`);
}
console.log(`  front door placed: ${doorReport.frontDoorPlaced}`);

const expectedInteriorDoors = Object.entries(resolvedAttachMap).filter(([srcId, targetId]) => {
  const a = byId.get(srcId);
  const b = byId.get(targetId);
  return a && b && a.type !== "front_door" && b.type !== "front_door";
}).length;

const allDoorsPlaced =
  doorReport.interiorDoorsSkipped.length === 0 &&
  doorReport.interiorDoorsPlaced.length === expectedInteriorDoors &&
  doorReport.frontDoorPlaced;
console.log(
  `  -> ${allDoorsPlaced ? "every attach-map relationship (and the front door) got an actual door cut" : "NOT every relationship got a door cut - see FAIL lines above"}`
);

console.log("\n=== Overall ===");
console.log(`  wall continuity: ${continuityFailures === 0 ? "PASS" : "FAIL"}`);
console.log(`  door-cut coverage: ${allDoorsPlaced ? "PASS" : "FAIL"}`);
