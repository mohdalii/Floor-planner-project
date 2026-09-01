// batch.test.mjs
//
// Day 6 milestone ("batch-test the rule engine... collision rate, boundary
// compliance, rule-satisfaction rate", docs/PLAN.md) as a real, committed,
// repeatable test - not another throwaway scratch script. The builder/
// checker/fixer cycle for Day 3-5 already produced exactly this kind of
// evidence (multiple 672- and 192-combo sweeps), but every one of those
// sweeps lived only in a disposable one-off file, per each agent's own
// account in STATUS.md. This file consolidates that same method into
// something that stays in the repo and can be re-run by anyone (`node
// --test server/src/ruleEngine/__tests__/batch.test.mjs`, or plain `node
// server/src/ruleEngine/__tests__/batch.test.mjs`) after any future change
// to the rule engine.
//
// Uses Node's built-in `node:test` + `node:assert` - no new dependency,
// consistent with the rest of this codebase (constants.js/roomProgram.js/
// etc are all plain ESM with zero runtime dependencies beyond Node itself).
// Running this file directly with `node` (no --test flag) still executes
// every test() block and exits non-zero if any assertion fails - Node's
// test runner does not require its CLI flag to run, only to get the nicer
// TAP-reporter output.
//
// Run from the repo root with:
//   node server/src/ruleEngine/__tests__/batch.test.mjs
// or, for the standard TAP-style runner output:
//   node --test server/src/ruleEngine/__tests__/batch.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import { buildRoomProgram } from "../roomProgram.js";
import { buildAttachMap } from "../attachMap.js";
import { seedLayout } from "../seeding.js";
import { solveLayout } from "../solver.js";
import { validateLayout } from "../validate.js";

// Runs one requirement set through the full pipeline and returns the
// validation result alongside the requirements that produced it, so a
// failure can be reproduced by hand from the printed requirements alone.
function runOne(requirements) {
  const rooms = buildRoomProgram(requirements);
  const attachMap = buildAttachMap(rooms);
  // seedLayout() returns a RESOLVED attachMap (chained for any room a
  // fan-out stack wrapped past its nominal target) alongside the seeded
  // rooms - see seeding.js's claimPosition comment. Every later stage uses
  // that resolved map, not the original buildAttachMap() output.
  const { rooms: seeded, attachMap: resolvedAttachMap } = seedLayout(rooms, attachMap);
  const solved = solveLayout(seeded, resolvedAttachMap);
  const validation = validateLayout(solved.rooms, resolvedAttachMap);
  return { requirements, validation, plot: solved.plot };
}

// Sweeps a combinatorial grid of requirement sets and returns aggregate
// stats: overall pass rate, and a per-check failure count so a regression
// in one specific rule (e.g. "kitchenAdjacentToLiving" alone starts
// failing) is visible instead of getting buried in one pass/fail number.
function sweep(grid) {
  const { bedrooms, bathrooms, kitchens, balconies, storages } = grid;
  const results = [];
  for (const bd of bedrooms) {
    for (const ba of bathrooms) {
      for (const k of kitchens) {
        for (const bal of balconies) {
          for (const st of storages) {
            results.push(
              runOne({
                bedrooms: bd,
                bathrooms: ba,
                kitchens: k,
                balconies: bal,
                storages: st,
              })
            );
          }
        }
      }
    }
  }
  return results;
}

// Aggregates a list of runOne() results into the shape Day 6 asks for:
// collision rate, boundary (exterior) compliance, and overall
// rule-satisfaction rate, broken down per check.
function summarize(results) {
  const total = results.length;
  const checkNames = Object.keys(results[0].validation.checks);
  const failCounts = Object.fromEntries(checkNames.map((name) => [name, 0]));
  let overallPassed = 0;

  for (const { validation } of results) {
    if (validation.passed) overallPassed += 1;
    for (const name of checkNames) {
      if (!validation.checks[name]) failCounts[name] += 1;
    }
  }

  return { total, overallPassed, failCounts };
}

function printSummary(label, summary) {
  const { total, overallPassed, failCounts } = summary;
  const pct = (n) => ((n / total) * 100).toFixed(1);
  console.log(`\n=== ${label}: ${total} combinations ===`);
  console.log(`  overall pass rate: ${overallPassed}/${total} (${pct(overallPassed)}%)`);
  for (const [check, fails] of Object.entries(failCounts)) {
    console.log(`  ${check.padEnd(24)} failures: ${fails}/${total} (${pct(fails)}%)`);
  }
}

// ---------------------------------------------------------------------
// Test 1: single end-to-end smoke case (mirrors demo.js's requirement
// set) - a fast, specific sanity check that fails loudly and immediately
// if something fundamental broke, before the slower sweep below even runs.
// ---------------------------------------------------------------------
test("a plausible mid-size family home passes every check", () => {
  const { validation, plot } = runOne({
    bedrooms: 3,
    bathrooms: 2,
    kitchens: 1,
    livingRooms: 1,
    balconies: 1,
    storages: 1,
  });

  assert.equal(validation.passed, true, JSON.stringify(validation.checks));
  assert.ok(plot.widthM > 0 && plot.depthM > 0, "plot must have positive extent");
});

// ---------------------------------------------------------------------
// Test 2: the livingRooms cap (reviewer's Day 3-5 close-out scope decision,
// see roomProgram.js Step 2b). Requesting more than 1 living room must be
// silently capped to exactly 1, not error and not pass extras through -
// this is what keeps the sweep below meaningful as a single-living-room
// sweep with no separate multi-living code path to account for.
// ---------------------------------------------------------------------
test("requesting multiple living rooms is capped to exactly 1", () => {
  const rooms = buildRoomProgram({ bedrooms: 2, bathrooms: 1, livingRooms: 3 });
  const livingRooms = rooms.filter((room) => room.type === "living");
  assert.equal(livingRooms.length, 1);

  const { validation } = runOne({ bedrooms: 2, bathrooms: 1, livingRooms: 3 });
  assert.equal(validation.passed, true, JSON.stringify(validation.checks));
});

// ---------------------------------------------------------------------
// Test 3: the batch sweep itself - collision rate, boundary compliance,
// and rule-satisfaction rate across a wide combinatorial grid of synthetic
// requirement sets. Same grid shape (672 combinations) as the checker/
// fixer's own ad-hoc single-living sweep during the Day 3-5 cycle, so this
// result is directly comparable to what STATUS.md already recorded
// (664/672, 98.8%) - this test is what makes that number re-checkable by
// anyone, any time, instead of only trusted on the fixer's word.
// ---------------------------------------------------------------------
test("batch sweep: collision rate, boundary compliance, rule-satisfaction rate", () => {
  const results = sweep({
    bedrooms: [1, 2, 3, 4, 5, 6],
    bathrooms: [0, 1, 2, 3, 4, 5, 6],
    kitchens: [0, 1],
    balconies: [0, 1, 2, 3],
    storages: [0, 2],
  });
  const summary = summarize(results);
  printSummary("Single-living-room requirement sweep", summary);

  // Hard requirements (Day 6's "collision rate" / "boundary compliance"):
  // a floor plan with an actual room overlap, or an entrance/balcony that
  // doesn't reach an exterior wall, is not just statistically disappointing
  // - it is physically unbuildable. These must be 100% across every
  // combination, with zero tolerance, unlike the softer size-judgement
  // check below.
  for (const hardCheck of [
    "noOverlaps",
    "frontDoorOnExterior",
    "balconiesOnExterior",
    "frontDoorNearLiving",
    "kitchenAdjacentToLiving",
    "ensuiteBathroomsAdjacent",
    // Added in the Day 7-8 fixer pass, then GENERALIZED (still Day 7-8, a
    // later pass) from a bedroom-only single-hop check into a real BFS
    // reachability check over every room type - see validate.js check 8's
    // own comment for the full story: the bedroom-only version held up
    // fine on its own terms, but a reviewer found it had no way to catch a
    // much bigger, separate defect (60.7% of this exact sweep produced at
    // least one sealed bathroom/storage room with zero doors anywhere).
    // This generalized check is what would have caught that, and now does
    // - it belongs in the same zero-tolerance "unbuildable geometry" bucket
    // as noOverlaps, not the softer statistical livingNotOversized
    // judgement call below.
    "everyRoomReachableFromLiving",
  ]) {
    assert.equal(
      summary.failCounts[hardCheck],
      0,
      `${hardCheck} failed on ${summary.failCounts[hardCheck]}/${summary.total} combinations - see printed requirements above`
    );
  }

  // Overall rule-satisfaction rate: livingNotOversized is a statistical
  // judgement call (dataset p90 with headroom), not a hard physical
  // constraint, so a handful of extreme/unrealistic combinations (see
  // STATUS.md's documented open issue: 1 bedroom + 4-6 bathrooms, no
  // kitchen) are an accepted, understood limitation rather than a bug.
  // 95% is a floor comfortably below the 98.8% actually observed, so this
  // assertion catches a real regression without being so tight it starts
  // failing on ordinary sweep-to-sweep noise if SIZE_RANGES ever gets
  // re-mined from an updated dataset.
  const passRate = summary.overallPassed / summary.total;
  assert.ok(
    passRate >= 0.95,
    `overall pass rate ${(passRate * 100).toFixed(1)}% fell below the 95% floor`
  );
});

// If this file is executed directly (not via `node --test`), node:test
// still runs every test() block above and prints results; this final log
// just makes it obvious the file reached the end without a hard crash.
console.log("\nbatch.test.mjs: all test() blocks registered and run.");
