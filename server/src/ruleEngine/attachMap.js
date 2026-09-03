// attachMap.js
//
// Encodes the "what should be next to what" rules for a home: which room
// each room wants to be adjacent to. buildAttachMap() returns a plain
// object mapping a room's id to the id of the room it should attach to,
// e.g. { bathroom_0: "bedroom_0" }. Rooms with no particular attach
// requirement of their own (in this design, only the main living room -
// everything else attaches TO it, directly or indirectly) simply have no
// entry in the returned object.
//
// seeding.js uses this map to decide WHERE to place a room relative to
// something already placed; solver.js uses it to decide whether a room's
// current position still satisfies its relationship, and to nudge it back
// toward its target if not; validate.js uses it for the final adjacency
// checks. So this file is pure relationship logic - no coordinates, no
// sizes - which is exactly why it's a separate module from seeding/solving.
//
// These rules mirror the earlier hybrid project's `_build_attach_map` logic
// conceptually (see docs/PLAN.md for the source reference) - re-derived
// here from scratch for this project's plain JS room objects, since that
// project's version worked on PyTorch tensors and isn't copy-pasteable.

/**
 * Build the attach map for a room list produced by buildRoomProgram().
 *
 * @param {Array<{id: string, type: string, typeIndex: number}>} rooms
 * @returns {Object<string, string>} roomId -> targetRoomId
 */
export function buildAttachMap(rooms) {
  const attachMap = {};

  // Group rooms by type, and within each type sort by typeIndex - that
  // index IS the room's "declaration order" (bedroom_0 was the user's
  // first bedroom, bedroom_1 the second, ...), which the rules below use to
  // decide things like "which bedroom is the master".
  const byType = {};
  for (const room of rooms) {
    if (!byType[room.type]) byType[room.type] = [];
    byType[room.type].push(room);
  }
  for (const list of Object.values(byType)) {
    list.sort((a, b) => a.typeIndex - b.typeIndex);
  }

  const livings = byType.living ?? [];
  const bedrooms = byType.bedroom ?? [];
  const bathrooms = byType.bathroom ?? [];
  const kitchens = byType.kitchen ?? [];
  const storages = byType.storage ?? [];
  const balconies = byType.balcony ?? [];
  const frontDoors = byType.front_door ?? [];
  const hallways = byType.hallway ?? [];

  // The "anchor" living room everything else orbits. buildRoomProgram()
  // always creates at least one (living_0). If this function is ever
  // called directly with a hand-built room list that has none, there is
  // nothing sensible for any rule below to attach to, so return an empty
  // map rather than guessing or crashing.
  const mainLiving = livings[0];
  if (!mainLiving) return attachMap;

  // Extra living rooms (a second lounge, a family room, ...) aren't covered
  // by name in the original rule list this file is based on. As a small,
  // reasonable extension in the same spirit ("everything orbits living"),
  // any living room beyond the first attaches to the main one, so it is
  // never left without any relationship of its own.
  for (let i = 1; i < livings.length; i++) {
    attachMap[livings[i].id] = mainLiving.id;
  }

  // "Master" bedroom = the first bedroom by declaration order (bedroom_0).
  // In the earlier ML-based project this rank came from the trained
  // model's PREDICTED size - the biggest predicted bedroom became
  // "master". Here, sizing only happens later (seeding.js/solver.js gives
  // rooms their actual dimensions), so there is no size yet to rank by at
  // this stage. Declaration order is used instead as a documented
  // simplification: it's simple, fully deterministic, and matches how
  // people naturally tend to list their master bedroom first.
  const masterBedroom = bedrooms[0];

  // --- Bedroom -> hallway: every bedroom's own route back to living -------
  // THE FIX this file was missing (see docs/PLAN.md / STATUS.md Day 7-8):
  // every rule below this point gives a bedroom a relationship pointing AT
  // it (an en-suite bathroom, the master's balcony) - none of them ever
  // gave a bedroom a relationship of its OWN. A bedroom with neither an
  // en-suite bathroom nor a balcony therefore had ZERO entries in this map
  // at all, meaning nothing downstream (seeding.js's placement, solver.js's
  // relationship-satisfaction cost, doors.js's door-cutting) had any reason
  // to ever connect it to the rest of the house. Confirmed systemic by the
  // checker: 17/17 bedrooms unreachable across 5 varied room programs,
  // including the "full en-suite" case, where a bedroom's only neighbour
  // (its own bathroom) had no relationship back to living either - two
  // sealed rooms, not one.
  //
  // roomProgram.js now always adds exactly one `hallway_0` (the same
  // "automatic room" pattern as front_door), and every bedroom attaches to
  // it here - the shared connector the user's own reference floor plans
  // show explicitly. This does NOT replace a bedroom's other relationships
  // below (an en-suite bathroom/balcony still attach TO the bedroom) - a
  // bedroom legitimately ends up with a relationship of its own here PLUS
  // however many relationships point at it. A plain object attach map
  // supports this without any conflict: hallway_0 ends up being both a KEY
  // in this object (its own entry, -> living, added right below) and a
  // VALUE in every bedroom's entry - verified directly against how this
  // object is actually used everywhere downstream (seeding.js/solver.js/
  // validate.js all look up `attachMap[someId]` independently by id; none
  // of them assume an id can only ever appear as a key OR a value, and nothing
  // here enforces that either - a plain `{}` has no such uniqueness
  // constraint on its values in the first place).
  const hallway = hallways[0];
  if (hallway) {
    for (const bedroom of bedrooms) {
      attachMap[bedroom.id] = hallway.id;
    }
    // --- Hallway -> living: the connector's own route to the shared zone --
    attachMap[hallway.id] = mainLiving.id;
  }

  // --- Bathroom <-> bedroom pairing ---------------------------------------
  // Verified against real data (this pass, 2026-09-01 -
  // data-analysis/analyze_connectivity.py re-run against the actual
  // 17,000-plan ResPlan dataset): en-suite (bathroom-to-bedroom) is the
  // single most common bathroom relationship in real plans by a wide margin
  // (23,348 via_door instances - more than any other bathroom connection
  // type), and this branch already pairs every bedroom with its own
  // bathroom first, before any bathroom becomes a shared "hall" bathroom -
  // confirmed unchanged and still correct, not touched by this pass.
  //
  // What WAS wrong, and is fixed this pass (not here - this file never
  // actually generated the bad relationship itself): once bathrooms.length
  // exceeds bedrooms.length, every "extra" bathroom below gets the exact
  // same target (`mainLiving.id`) - a genuine, real, shared architectural
  // target (real data backs this too: 2,102 of 16,848 multi-bathroom plans
  // have living with a direct door to 2+ bathrooms simultaneously). The bug
  // was downstream, in seeding.js: when more than one bathroom shared that
  // one target and the seeding stack ran out of room on the target's own
  // wall, a previous fixer pass "resolved" the overflow by silently
  // rewriting the SECOND (and later) bathroom's effective target to
  // whichever sibling bathroom it physically landed beside instead -
  // bathroom_1 -> bathroom_0, never -> living_0 - even though this file
  // still (correctly) records bathroom_1 -> living_0 right here. Real data
  // shows that's essentially never how real houses connect a second
  // bathroom (a genuine door directly between two bathrooms: only 66 of
  // 40,261 real bathrooms across multi-bathroom plans, 0.16%). That
  // chaining logic has been removed entirely from seeding.js this pass -
  // see its own big design comment for the replacement (every bathroom
  // sharing this file's "-> living" target now gets a genuine independent
  // slot spread across living's own real wall length, not a fabricated
  // relationship to a sibling). This file's own output (the map below)
  // never changes as a result - it was never the source of the bug, and
  // stays exactly as it already was.
  if (bathrooms.length >= bedrooms.length) {
    // Enough bathrooms to give every bedroom its own en-suite. Pair them
    // off master-first: bedroom_0 with bathroom_0, bedroom_1 with
    // bathroom_1, and so on.
    for (let i = 0; i < bedrooms.length; i++) {
      attachMap[bathrooms[i].id] = bedrooms[i].id;
    }
    // Any bathrooms left over once every bedroom already has one become
    // extra shared bathrooms off the living area (covers the
    // bathrooms > bedrooms case).
    for (let i = bedrooms.length; i < bathrooms.length; i++) {
      attachMap[bathrooms[i].id] = mainLiving.id;
    }
  } else {
    // Not enough bathrooms to give every bedroom an en-suite. Rather than
    // arbitrarily giving some bedrooms a private bathroom and leaving
    // others with none - a favouritism the user never actually asked
    // for - ALL bathrooms become shared "hall" bathrooms attached to
    // living instead. This is also the common real-world pattern in a
    // home that's genuinely short on bathrooms.
    for (const bathroom of bathrooms) {
      attachMap[bathroom.id] = mainLiving.id;
    }
  }

  // --- Kitchen: always off living ------------------------------------------
  for (const kitchen of kitchens) {
    attachMap[kitchen.id] = mainLiving.id;
  }

  // --- Storage: off the kitchen if there is one, else off living ----------
  // Real data (data-analysis/analyze_connectivity.py, re-run this pass):
  // storage is a much rarer case than bathroom - only 15 of 17,000 real
  // ResPlan plans even have 2+ storage rooms - so unlike bathroom, this
  // file gives every storage room the SAME single nominal target here
  // (kitchen if one exists, else living) without a special-cased second
  // target of its own. seeding.js's redesign (this pass) still needs a
  // rare-case fallback for when 2 storage rooms don't both fit beside a
  // small kitchen, though: it falls back to living directly (a real,
  // different, valid target - not a same-type storage-to-storage chain,
  // which this pass removes for storage the same as for bathroom). See
  // seeding.js's storage block for the fallback logic.
  const storageTarget = kitchens[0] ?? mainLiving;
  for (const storage of storages) {
    attachMap[storage.id] = storageTarget.id;
  }

  // --- Balconies: first one is the master bedroom's, the rest go off living
  for (let i = 0; i < balconies.length; i++) {
    if (i === 0 && masterBedroom) {
      attachMap[balconies[i].id] = masterBedroom.id;
    } else {
      attachMap[balconies[i].id] = mainLiving.id;
    }
  }

  // --- Front door: always off living ---------------------------------------
  // So the entrance never opens directly into a bedroom (or any other
  // private room) - whoever walks in first should land in the
  // shared/public part of the home.
  for (const frontDoor of frontDoors) {
    attachMap[frontDoor.id] = mainLiving.id;
  }

  return attachMap;
}
