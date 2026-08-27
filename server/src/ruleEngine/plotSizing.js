// plotSizing.js
//
// Estimates a NOMINAL total floor area (and a unit-to-metres conversion
// factor) for a room program, before any actual layout exists yet. This is
// deliberately just a starting scale, not the final plot size - the real
// plot width/depth are only known once solver.js has actually placed every
// room and can measure the resulting layout's bounding box (see the end of
// solveLayout() in solver.js). In other words: plot size is a CONSEQUENCE
// of the room program, worked out from it, not something fed in upfront as
// an input.
//
// Ported concept (not code - the old project's version ran on PyTorch
// tensors) from the earlier hybrid project's
// predict.py:estimate_plot_dimensions_m, re-derived here for this
// project's plain-number room list. See docs/PLAN.md for the reference.

import { SIZE_RANGES } from "./constants.js";

// A room program is assumed to comfortably fit on a plot if its rooms' pure
// floor area adds up to no more than this fraction of the plot. The
// remaining ~18% isn't wasted - it's what every real home needs beyond the
// rooms themselves: wall thickness, hallway/circulation space, and general
// slack so rooms aren't crammed edge-to-edge. 0.82 matches the value the
// earlier hybrid project arrived at; it's kept here as a reasonable
// architectural rule of thumb rather than re-derived, since ResPlan's
// polygons don't directly tell us how much circulation space real plans
// use (they only give us room areas, not corridor/wall areas).
const USABLE_PLOT_FRACTION = 0.82;

// A reasonable baseline total floor area (square metres) for a typical
// modest home, used as the starting point before scaling for a specific
// room program. This is a fixed, documented assumption, not something
// derived from the dataset - ResPlan's room polygons are in
// normalised/unitless coordinates, not real metres, so there's no dataset
// value to read a "typical home is N square metres" figure from.
const BASE_HOME_AREA_M2 = 90;

/**
 * Estimate a nominal total area and a unit-to-metres conversion factor for
 * the given room list.
 *
 * @param {Array<{type: string}>} rooms - anything with a `.type` field
 *   works here (a raw room-program list from buildRoomProgram, or
 *   seeded/solved boxes from seeding.js/solver.js) - only the room TYPES
 *   matter to this function, not any position or size already assigned to
 *   them.
 * @returns {{ nominalAreaM2: number, metersPerUnit: number }}
 */
export function estimatePlotDimensions(rooms) {
  // Add up the MINIMUM area fraction (SIZE_RANGES[type].min) each room in
  // the program needs. This is a lower bound on how much of the plot the
  // rooms alone will require, before accounting for walls/circulation.
  let totalMinFraction = 0;
  for (const room of rooms) {
    const range = SIZE_RANGES[room.type];
    if (!range) {
      throw new Error(
        `estimatePlotDimensions: unknown room type "${room.type}"`
      );
    }
    totalMinFraction += range.min;
  }

  // If the rooms alone would need more than the usable fraction of a
  // baseline-sized plot, scale the baseline area up proportionally so
  // there's still room left over for walls/circulation once the rooms are
  // actually placed. A room program comfortably within the baseline's
  // capacity (totalMinFraction <= USABLE_PLOT_FRACTION) just uses the
  // baseline area as-is - there's no need to shrink it for a small program.
  const scale =
    totalMinFraction > USABLE_PLOT_FRACTION
      ? totalMinFraction / USABLE_PLOT_FRACTION
      : 1;
  const nominalAreaM2 = BASE_HOME_AREA_M2 * scale;

  // metersPerUnit converts a LENGTH in the rule engine's normalised "unit"
  // space into real metres. SIZE_RANGES areas are fractions of a plot
  // treated as having area 1 (unit^2) - so nominalAreaM2 is the real-world
  // area that "1 unit^2" is defined to represent for this room program.
  // Since area scales with the SQUARE of length, converting an area into a
  // length-scale factor means taking its square root: a square patch of
  // nominalAreaM2 square metres has a side length of sqrt(nominalAreaM2)
  // metres, and that side length is exactly what "1 unit" of length is
  // worth here.
  const metersPerUnit = Math.sqrt(nominalAreaM2);

  return { nominalAreaM2, metersPerUnit };
}
