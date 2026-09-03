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
  // seedLayout() returns a RESOLVED attachMap (re-pointed at a genuinely
  // different, valid target for the rare room that needs it - e.g. storage
  // falling back from kitchen to living, never a same-type sibling - see
  // seeding.js's edge-based fan-out design comment) alongside the seeded
  // rooms. Every later stage uses that resolved map, not the original
  // buildAttachMap() output.
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
    // Added this pass (Day 7-8, second redesign - replaces the previous
    // fixer pass's chaining trade-off, not an addition to it): real ResPlan
    // data (data-analysis/analyze_connectivity.py) showed a genuine door
    // directly between two bathrooms happens in only 0.16% of real
    // multi-bathroom plans, yet the previous fix made exactly that the
    // ROUTINE outcome (60.7% same-type chaining rate on this exact grid -
    // see STATUS.md's Day 7-8 entries). seeding.js was redesigned to spread
    // same-target siblings across the real target's own edge(s) instead of
    // chaining them together, and this check is the direct, cheap
    // regression guard for that promise: under the redesign it is always
    // zero (not just usually low - a same-type override is never written
    // any more, not even in the rare residual case below), so it belongs in
    // this zero-tolerance bucket, unlike everyRoomReachableFromLiving below.
    "noSameTypeChaining",
  ]) {
    assert.equal(
      summary.failCounts[hardCheck],
      0,
      `${hardCheck} failed on ${summary.failCounts[hardCheck]}/${summary.total} combinations - see printed requirements above`
    );
  }

  // everyRoomReachableFromLiving: added in the Day 7-8 fixer pass as a
  // zero-tolerance hard check (a bedroom-only reachability check
  // generalized to every room type after a reviewer found 60.7% of this
  // exact sweep produced at least one sealed room with literally zero
  // doors). It stayed zero-tolerance through that pass because the fix
  // (chaining a room to whichever same-type sibling it physically touched)
  // made real reachability ALWAYS achievable, just sometimes indirect.
  //
  // This pass deliberately REMOVES that chaining (see the noSameTypeChaining
  // check above, and seeding.js's big design comment, for why - it doesn't
  // match how real houses connect a second bathroom). The honest
  // consequence, measured directly on this exact grid: a small number of
  // GENUINELY EXTREME room programs (more same-type siblings sharing one
  // target than even a second edge of that target can hold - e.g. 1 bedroom
  // with 5-6 bathrooms, or 5-6 bedrooms with 4-5 bathrooms, i.e. almost
  // every bathroom in the house needing to be a shared hall bathroom off one
  // living room) still can't reach living through a real door. This is
  // exactly the kind of case this pass's own brief called out as an
  // acceptable, honestly-labelled residual limitation - AS LONG AS it stays
  // rare, not the previous ~60% hit-rate. It's asserted here with a real
  // ceiling instead of forcing it back to zero (which would mean silently
  // re-introducing same-type chaining to hide it, exactly the trade-off
  // this pass exists to remove): 10% is a ceiling comfortably above the
  // 5.95% (40/672) actually observed, so this still catches a real
  // regression (e.g. the redesign's edge-based fan-out breaking and
  // reverting toward the old ~60% rate) without being brittle to ordinary
  // sweep-to-sweep noise. Confirmed confined to the same flavour of
  // unrealistic combos already accepted for livingNotOversized below (1
  // bedroom + 5-6 bathrooms, no kitchen and WITH kitchen; 2 bedrooms + 6
  // bathrooms; 5-6 bedrooms + 4-5 bathrooms) - not ordinary requests like
  // the project's own 3-bed/2-bath demo or a plain 4-bed/2-bath household,
  // both of which have zero same-type chaining AND zero unreachable rooms
  // under this redesign.
  const reachabilityFailRate = summary.failCounts.everyRoomReachableFromLiving / summary.total;
  assert.ok(
    reachabilityFailRate <= 0.1,
    `everyRoomReachableFromLiving failure rate ${(reachabilityFailRate * 100).toFixed(1)}% exceeded the 10% ceiling ` +
      `(${summary.failCounts.everyRoomReachableFromLiving}/${summary.total}) - see printed requirements above`
  );

  // Overall rule-satisfaction rate: livingNotOversized is a statistical
  // judgement call (dataset p90 with headroom), and everyRoomReachableFromLiving
  // now legitimately fails on a small, documented set of genuinely extreme
  // programs (see above) - neither is a hard physical constraint the way
  // the checks in the loop above are, so a floor here (not 100%) is the
  // right standard. 90% is comfortably below the 94.0% actually observed
  // after this pass's redesign (632/672 - down slightly from the previous
  // 668/672/99.4% specifically BECAUSE this pass stopped silently faking
  // reachability via same-type chaining, not because anything regressed -
  // see STATUS.md's Day 7-8 redesign entry for the full accounting), so
  // this still catches a real regression without being brittle to ordinary
  // sweep-to-sweep noise.
  const passRate = summary.overallPassed / summary.total;
  assert.ok(
    passRate >= 0.9,
    `overall pass rate ${(passRate * 100).toFixed(1)}% fell below the 90% floor`
  );
});

// If this file is executed directly (not via `node --test`), node:test
// still runs every test() block above and prints results; this final log
// just makes it obvious the file reached the end without a hard crash.
console.log("\nbatch.test.mjs: all test() blocks registered and run.");
