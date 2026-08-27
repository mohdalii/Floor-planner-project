"""
One-off, offline script. Not part of the shipped app.

Mines the ResPlan dataset (17,000 real residential floor plans, Kaggle,
CC BY-NC-SA 4.0 - see docs/PLAN.md for citation) for:
  - room-type frequency (how common each room type is)
  - adjacency-pair frequency (which room types are placed next to each
    other, and how often - grounds the rule engine's attach-map priorities
    in real layouts instead of arbitrary guesses)
  - room size ratio by type (each room's area as a fraction of its plan's
    total room area - grounds the rule engine's SIZE_RANGES)

Reads the pre-extracted JSON files the old project already produced
(resplan_graphs.json, training_samples.json) rather than the raw pickle,
so this needs nothing beyond the Python standard library.

Output: data-analysis/output/rule-constants.seed.json - a small derived
summary, safe to commit (the 80-100MB source datasets are not).

Usage:
    python seed_stats.py [--dataset-dir PATH]
"""

import argparse
import json
import statistics
from collections import Counter, defaultdict
from pathlib import Path

DEFAULT_DATASET_DIR = Path("D:/ai-floor-planner/dataset")
OUTPUT_PATH = Path(__file__).parent / "output" / "rule-constants.seed.json"


def load_json(path):
    print(f"Reading {path} ...")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def room_type_frequency(graphs):
    counts = Counter()
    for plan in graphs:
        for node in plan["nodes"]:
            counts[node["type"]] += 1
    return dict(counts.most_common())


def adjacency_pair_frequency(graphs):
    counts = Counter()
    for plan in graphs:
        node_type = {node["id"]: node["type"] for node in plan["nodes"]}
        for edge in plan["edges"]:
            a = node_type.get(edge["source"])
            b = node_type.get(edge["target"])
            if not a or not b:
                continue
            pair = tuple(sorted([a, b]))
            counts[pair] += 1
    return [
        {"pair": list(pair), "count": count}
        for pair, count in counts.most_common()
    ]


def size_ratio_by_type(samples):
    ratios = defaultdict(list)
    for sample in samples:
        rooms = sample["target"]["rooms"]
        total_area = sum(r["area"] for r in rooms)
        if total_area <= 0:
            continue
        for room in rooms:
            ratios[room["type"]].append(room["area"] / total_area)

    summary = {}
    for room_type, values in ratios.items():
        values.sort()
        summary[room_type] = {
            "count": len(values),
            "min": values[0],
            "p10": values[int(len(values) * 0.10)],
            "median": statistics.median(values),
            "p90": values[int(len(values) * 0.90)],
            "max": values[-1],
            "mean": statistics.mean(values),
        }
    return summary


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset-dir", type=Path, default=DEFAULT_DATASET_DIR)
    args = parser.parse_args()

    graphs = load_json(args.dataset_dir / "resplan_graphs.json")
    samples = load_json(args.dataset_dir / "training_samples.json")

    print("Computing room-type frequency...")
    type_frequency = room_type_frequency(graphs)

    print("Computing adjacency-pair frequency...")
    adjacency = adjacency_pair_frequency(graphs)

    print("Computing size ratios by room type...")
    size_ratios = size_ratio_by_type(samples)

    result = {
        "source": "ResPlan (Kaggle, CC BY-NC-SA 4.0), mined via data-analysis/seed_stats.py",
        "plan_count": len(graphs),
        "room_type_frequency": type_frequency,
        "adjacency_pair_frequency_top_30": adjacency[:30],
        "size_ratio_by_type": size_ratios,
    }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)

    print(f"\nWrote {OUTPUT_PATH}")
    print(f"Plans analyzed: {len(graphs)}")
    print(f"Room types found: {list(type_frequency.keys())}")


if __name__ == "__main__":
    main()
