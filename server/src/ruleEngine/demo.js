// demo.js
//
// A small, directly-runnable smoke test for the rule engine. Builds a
// plausible room program and runs it through every stage of the pipeline -
// buildRoomProgram -> buildAttachMap -> seedLayout -> solveLayout ->
// validateLayout - then prints the result to the console.
//
// This is NOT an automated test suite (that's the Day 6 batch-testing
// milestone, which will run this pipeline over many randomised requirement
// sets and assert things about the results). This file exists purely so a
// human can manually eyeball, right now, that the whole pipeline actually
// runs end-to-end without throwing and produces something that looks like
// a sane floor plan.
//
// Run from the repo root with:
//   node server/src/ruleEngine/demo.js

import { buildRoomProgram } from "./roomProgram.js";
import { buildAttachMap } from "./attachMap.js";
import { seedLayout } from "./seeding.js";
import { solveLayout } from "./solver.js";
import { validateLayout } from "./validate.js";

// A plausible mid-size family home: 3 bedrooms, 2 bathrooms (fewer than
// bedrooms, so attachMap.js's "shared hall bathroom" rule kicks in rather
// than one-to-one en-suites - a deliberately useful case to smoke-test),
// 1 kitchen, 1 living room, 1 balcony, 1 storage room, plus the automatic
// front door buildRoomProgram always adds.
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

// Stage 1: turn requirement counts into a flat list of room objects.
const rooms = buildRoomProgram(requirements);
console.log(`\n=== Room program (${rooms.length} rooms) ===`);
for (const room of rooms) {
  console.log(`  ${room.id}`);
}

// Stage 2: work out which room should attach to which.
const attachMap = buildAttachMap(rooms);
console.log("\n=== Attach map ===");
for (const [roomId, targetId] of Object.entries(attachMap)) {
  console.log(`  ${roomId} -> ${targetId}`);
}

// Stage 3: rough first-guess placement (may overlap, may break rules - see
// seeding.js's big comment for why that's expected and fine at this stage).
// seedLayout() also returns a RESOLVED attachMap (chained for any room a
// fan-out stack wrapped past its nominal target - see seeding.js's
// claimPosition comment) - that resolved map, not the original one from
// buildAttachMap() above, is what every later stage should use.
const { rooms: seeded, attachMap: resolvedAttachMap } = seedLayout(rooms, attachMap);

// Stage 4: minimal-movement refinement - fixes collisions/relationships
// left over from seeding, while moving as little as possible.
const solved = solveLayout(seeded, resolvedAttachMap);

console.log("\n=== Solved rooms ===");
for (const room of solved.rooms) {
  console.log(
    `  ${room.id.padEnd(14)} cx=${room.cx.toFixed(3)} cy=${room.cy.toFixed(3)} ` +
      `w=${room.w.toFixed(3)} h=${room.h.toFixed(3)}`
  );
}

console.log("\n=== Plot (measured from the solved layout) ===");
console.log(`  width: ${solved.plot.widthM.toFixed(2)} m`);
console.log(`  depth: ${solved.plot.depthM.toFixed(2)} m`);
console.log(`  area:  ${solved.plot.areaM2.toFixed(2)} m^2`);

console.log("\n=== Resolved attach map (post-seeding, used for solving/validation) ===");
for (const [roomId, targetId] of Object.entries(resolvedAttachMap)) {
  const original = attachMap[roomId];
  const chained = original !== targetId ? `  (chained - was -> ${original})` : "";
  console.log(`  ${roomId} -> ${targetId}${chained}`);
}

// Stage 5: read-only usability checklist.
const validation = validateLayout(solved.rooms, resolvedAttachMap);
console.log("\n=== Validation ===");
console.log(`  overall passed: ${validation.passed}`);
for (const [check, ok] of Object.entries(validation.checks)) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${check}`);
}
