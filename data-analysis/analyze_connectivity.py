"""
One-off, offline script. Not part of the shipped app.

The rule engine's seeding/solver currently stacks repeated room types
(2nd+ bathroom, 2nd+ storage room) behind one another, so only the first
one directly touches its attach target - the rest reach it only by
chaining through their sibling. A user flagged this as unrealistic: real
houses don't usually route through one bathroom to reach another.

This script checks what real plans in the ResPlan dataset actually do:
does a room like "living" commonly have DIRECT door connections to
multiple bathrooms/storage rooms at once (implying they should be seeded
side-by-side along a shared wall, each with its own frontage), or do
multi-bathroom plans typically use some other pattern (each bathroom
paired with its own bedroom, one shared bathroom + rest en-suite,
bathroom-to-bathroom doors, etc.)?

Uses resplan_graphs.json's edge "type" field (via_door / via_window /
adjacency / direct) to distinguish a real passable connection (via_door)
from mere physical touching (adjacency).

Usage:
    python analyze_connectivity.py [--dataset-dir PATH]
"""

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

DEFAULT_DATASET_DIR = Path("D:/ai-floor-planner/dataset")


def load_json(path):
    print(f"Reading {path} ...")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset-dir", type=Path, default=DEFAULT_DATASET_DIR)
    args = parser.parse_args()

    graphs = load_json(args.dataset_dir / "resplan_graphs.json")
    print(f"Plans loaded: {len(graphs)}\n")

    # --- 1. For plans with 2+ bathrooms, how does each bathroom connect? ---
    multi_bath_plans = 0
    bathroom_direct_to_living = Counter()   # per-plan count of bathrooms with via_door to living
    bathroom_to_bedroom = 0
    bathroom_to_bathroom_door = 0
    bathroom_to_bathroom_adjacency_only = 0
    bathroom_isolated = 0                    # no via_door edge to anything
    total_bathrooms_in_multi_plans = 0

    # --- 2. Does "living" ever have via_door edges to MULTIPLE bathrooms
    #        in the same plan? (the key question) ---
    living_multi_bathroom_door_plans = 0
    living_bathroom_door_counts = Counter()  # histogram: how many bathrooms does living door to, per plan

    # --- 3. Same questions for storage ---
    multi_storage_plans = 0
    storage_direct_to_kitchen_or_living = Counter()
    storage_to_storage_door = 0

    for plan in graphs:
        nodes = {n["id"]: n["type"] for n in plan["nodes"]}
        # adjacency list of via_door edges only (a real passable connection)
        door_edges = [e for e in plan["edges"] if e["type"] == "via_door"]
        all_edges = plan["edges"]

        door_neighbors = defaultdict(set)
        for e in door_edges:
            door_neighbors[e["source"]].add(e["target"])
            door_neighbors[e["target"]].add(e["source"])

        any_neighbors = defaultdict(set)
        for e in all_edges:
            any_neighbors[e["source"]].add(e["target"])
            any_neighbors[e["target"]].add(e["source"])

        living_ids = [nid for nid, t in nodes.items() if t == "living"]
        bathroom_ids = [nid for nid, t in nodes.items() if t == "bathroom"]
        bedroom_ids = [nid for nid, t in nodes.items() if t == "bedroom"]
        storage_ids = [nid for nid, t in nodes.items() if t == "storage"]
        kitchen_ids = [nid for nid, t in nodes.items() if t == "kitchen"]

        if len(bathroom_ids) >= 2:
            multi_bath_plans += 1
            total_bathrooms_in_multi_plans += len(bathroom_ids)

            living_door_count = 0
            for bid in bathroom_ids:
                neighbors = door_neighbors[bid]
                connects_living = any(n in living_ids for n in neighbors)
                connects_bedroom = any(n in bedroom_ids for n in neighbors)
                connects_bathroom_door = any(n in bathroom_ids for n in neighbors)

                if connects_living:
                    living_door_count += 1
                if connects_bedroom:
                    bathroom_to_bedroom += 1
                if connects_bathroom_door:
                    bathroom_to_bathroom_door += 1
                elif any(n in bathroom_ids for n in any_neighbors[bid]):
                    bathroom_to_bathroom_adjacency_only += 1
                if not neighbors:
                    bathroom_isolated += 1

            living_bathroom_door_counts[living_door_count] += 1
            if living_door_count >= 2:
                living_multi_bathroom_door_plans += 1

        if len(storage_ids) >= 2:
            multi_storage_plans += 1
            for sid in storage_ids:
                neighbors = door_neighbors[sid]
                connects_target = any(
                    n in living_ids or n in kitchen_ids for n in neighbors
                )
                if connects_target:
                    storage_direct_to_kitchen_or_living[sid] += 1
                if any(n in storage_ids for n in neighbors):
                    storage_to_storage_door += 1

    print("=" * 70)
    print("MULTI-BATHROOM PLANS")
    print("=" * 70)
    print(f"Plans with 2+ bathrooms: {multi_bath_plans}")
    print(f"Total bathrooms in those plans: {total_bathrooms_in_multi_plans}")
    print(f"Bathroom-to-bedroom (via_door) instances: {bathroom_to_bedroom}")
    print(f"Bathroom-to-bathroom (via_door, i.e. a REAL door between two bathrooms): {bathroom_to_bathroom_door}")
    print(f"Bathroom-to-bathroom (touching but NOT via_door, i.e. just adjacent): {bathroom_to_bathroom_adjacency_only}")
    print(f"Bathrooms with zero via_door edges at all (isolated in the graph): {bathroom_isolated}")
    print()
    print("Distribution of 'how many bathrooms does living door directly to' per multi-bath plan:")
    for count, plans in sorted(living_bathroom_door_counts.items()):
        print(f"  living connects directly to {count} bathroom(s): {plans} plans")
    print(f"\nPlans where living has via_door to 2+ bathrooms SIMULTANEOUSLY: {living_multi_bathroom_door_plans} / {multi_bath_plans}")

    print()
    print("=" * 70)
    print("MULTI-STORAGE PLANS")
    print("=" * 70)
    print(f"Plans with 2+ storage rooms: {multi_storage_plans}")
    print(f"Storage-to-storage via_door instances: {storage_to_storage_door}")
    print(f"Storage rooms with a direct via_door to kitchen/living: {sum(storage_direct_to_kitchen_or_living.values())}")

    # --- 4. Is there any explicit hallway/corridor-like node type at all? ---
    print()
    print("=" * 70)
    print("ALL NODE TYPES SEEN IN THE DATASET (checking for hallway/corridor)")
    print("=" * 70)
    type_counts = Counter()
    for plan in graphs:
        for n in plan["nodes"]:
            type_counts[n["type"]] += 1
    for t, c in type_counts.most_common():
        print(f"  {t}: {c}")


if __name__ == "__main__":
    main()
