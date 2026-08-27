# Floor Planner Rebuild — Pure Rule-Engine, MERN Stack, 15-Day Plan

## Context

The Phase 1 report (`Floor_Plan_Generator_Phase1_Report.docx.PDF`) describes a hybrid architecture: a trained geometry model predicts room boxes, and a rule-based layer + minimum-movement solver corrects them. The existing codebase at `D:\ai-floor-planner` actually implements that hybrid faithfully (and further than the report admits — the rule-engine solver, plot sizing, and diagnostics described as "being implemented" are done).

The user has decided, after being shown this, to proceed anyway with a **pure rule-engine generator — no trained ML model for geometry** — in a brand-new empty repo (`github.com/mohdalii/Floor-planner-project`, cloned into this working directory). The user also wants the stack to be **MERN** (Node/Express/MongoDB/React) wherever reasonable, since they'll be interviewing as a MERN developer. Deadline is 15 days out (~2026-09-11).

Working agreement with the user: **collaborative build**, not autonomous ghostwriting — every milestone gets a plain-language explanation so the user can understand and defend the code (their mentor asked them to do the work themselves; this keeps that true in substance, not just in git metadata). No attempt to hide tool use via commit history; normal commits under the user's authorship.

Two background research passes (not full copies — this is a new repo, nothing is being copied wholesale) established what's reusable as *design knowledge* from the old project, since starting 100% from a blank page in 15 days is not realistic:

- **The old rule engine's logic is ~85-90% pure geometry/rules** (priority tiers, attach-map adjacency rules, lexicographic tiered-cost conflict resolution, exterior-wall enforcement, a `validate_layout()` checklist) — conceptually portable to JS, not copy-pasteable (it's Python/PyTorch). Source: `D:\ai-floor-planner\python\app\training\geometry\_layout\_solver.py`.
- **The real gap**: that solver only *refines* an already-roughly-placed layout — the rough placement always came from the trained model. A pure rule-based generator needs a **new initial-seeding stage** that doesn't exist anywhere in the old code.
- **ResPlan dataset** (`D:\ai-floor-planner\dataset\ResPlan.pkl` + derived JSON/CSV files) is a real, public, licensed dataset (Kaggle, CC BY-NC-SA 4.0, 17,000 residential floor plans, South-Asian market) with real room polygons and adjacency graphs. Its aggregate stats (room-type frequency, adjacency-pair frequency, room-size ratios) can ground the new rule constants in real data instead of arbitrary numbers — this also preserves the report's "generated from a structured floor-plan dataset" framing even though placement itself is rule-driven, not learned. Non-commercial academic use is fine under CC BY-NC-SA; cite it in the report.
- **No construction-cost data exists anywhere** (checked both the repo and the raw dataset — genuinely absent). The cost-estimation module will be a documented, formula/lightly-regressed estimator built on reasonable assumptions, disclosed as such — not presented as trained on real cost data it wasn't.
- **AutoCAD**: the report's literal Scope section (3.2) only requires **DXF export** for AutoCAD editing; the "C# .NET plugin for live sync" is a Tools/Technologies stretch item, never implemented in the old project either (no `.cs` files exist). Given 15 days, DXF export satisfies the actual scope requirement; a live plugin is out of scope / future work.

## Target Architecture

```
Floor-planner-project/
  server/                     Node.js + Express API
    src/
      ruleEngine/
        constants.js          ROOM_TYPES, SIZE_RANGES, PRIORITY — seeded from ResPlan stats
        roomProgram.js         user requirement counts -> validated room list
        plotSizing.js           room-program -> plot width/depth (ported logic, see below)
        attachMap.js             adjacency rules: entrance->living, kitchen->living,
                                  bedroom<->bathroom pairing (en-suite / shared-hall),
                                  balcony->master bedroom or living, storage->kitchen
        seeding.js                NEW: zone-based initial placement in priority order
                                   (living anchor -> private bedroom zone -> bathrooms ->
                                   kitchen -> storage -> balcony/front-door on exterior)
        solver.js                  ported minimal-movement refinement loop: priority-
                                    ordered settling, lexicographic (hard-violation,
                                    relationship, stability) cost, collision safety net,
                                    exterior-wall enforcement
        validate.js                 post-generation checklist (no overlaps, front door on
                                     exterior + near living, kitchen adjacent to living,
                                     balconies on exterior, en-suite adjacency, living not
                                     oversized)
      costEstimation/
        estimateCost.js         formula/regression cost estimate, assumptions documented
      dxf/
        exportDxf.js             hand-written minimal DXF (LWPOLYLINE + TEXT per room) —
                                  no shaky dependency, and the user can fully explain it
      routes/  models/ (Mongoose)  app.js
  client/                      React (Vite) — already scaffolded, needs real components
    src/
      components/ RequirementsForm, PlanViewer2D (SVG), PlanViewer3D (Three.js), CostPanel
      pages/ Home, Generate, Result
  data-analysis/               one-off, NOT part of the shipped app
    seed_stats.py               mines ResPlan.pkl / resplan_graphs.json once for room-type
                                 frequency, adjacency-pair frequency, size ratios by type ->
                                 writes rule-constants seed JSON consumed by constants.js
  docs/                        updated Phase 2 report content (methodology rewritten to
                                match what's actually built: pure rule engine, not hybrid)
```

**Why this shape**: dropping the trained geometry model removes the only real reason the old project needed Python/PyTorch in the product itself. Everything that's left — API, rule engine, DXF writer, cost formula — is ordinary application logic that fits Node/Express cleanly, which serves the MERN-interview goal. Python is used exactly once, offline, to mine statistics from the dataset — that's data analysis, not part of the deployed app.

### Plot sizing (ported concept, from `predict.py:estimate_plot_dimensions_m`)
Sum each room's *minimum* size fraction (`SIZE_RANGES`) → scale a baseline nominal area up if the room program needs more than ~82% of it → derive a meters-per-unit factor → after seeding+solving, measure the actual layout extent in those units. Plot size is a *consequence* of the room program, not an input — matches the report's dynamic-plot-sizing requirement (1.4, 4.3.1) directly.

### Rule/priority tiers (design reference, not copied code)
`living(100) > bedroom(85) > bathroom(70) > kitchen(60) > storage(40) > balcony(25) > front_door(10)` — public zone settles first, then private zone, then dependents, then service/exterior rooms, then entrance. Conflict resolution compares candidates lexicographically: (1) collision severity, (2) rule-relationship satisfaction (attach-target gap, exterior-wall requirement, bedroom-zone cohesion), (3) stability (distance from the seeded position, replacing the old "distance from ML prediction" term — this is the one piece that genuinely needs re-deriving rather than porting, since there's no model prediction to stay close to anymore).

## 15-Day Roadmap

| Days | Milestone |
|---|---|
| 1-2 | Repo scaffold (Express + Mongoose + React/Vite already exists, wire dev scripts); `data-analysis/seed_stats.py` mines ResPlan for room-frequency / adjacency-frequency / size-ratio stats → `rule-constants.seed.json` |
| 3-5 | Rule engine core: constants, room-program logic, attach-map, **new seeding stage**, ported minimal-movement solver, validation checklist |
| 6 | Batch-test the rule engine against many synthetic requirement sets (no dataset "ground truth" needed here — pure generation): collision rate, boundary compliance, rule-satisfaction rate |
| 7-8 | DXF export (hand-written) + quick 2D SVG preview in the client for fast visual iteration |
| 8-9 | Cost estimation module, assumptions documented in code comments and later in the report |
| 9-10 | Express API routes + MongoDB schemas wiring room program → seeding → solver → validation → cost → persisted plan |
| 10-12 | React frontend: requirements form, 2D viewer, Three.js 3D viewer, cost panel, DXF download |
| 13 | End-to-end integration pass, bug fixing |
| 14 | Rewrite the report's methodology chapter to match what's actually built (pure rule engine, dataset-grounded constants, dropped ML geometry model, dropped live AutoCAD plugin, documented cost-model assumptions) |
| 15 | Buffer, polish, defense prep |

## Claude Code Agent Pipeline (the 4 agents requested)

Defined as project-scoped custom subagents in `Floor-planner-project/.claude/agents/`, coordinated through **`STATUS.md`** in the repo root — a single running work-log the user asked for directly: what's been built, what's left, and why each milestone was implemented the way it was (plain-language, not just a checklist), so it doubles as both the agents' coordination file and the user's own record of the project for their defense. Structure: one section per roadmap milestone (matching the table above), each with a Done/In-progress/Not-started status, a short explanation of what was built and the reasoning behind it, and any deviations from the plan. All four agents read/write it:

1. **`builder`** — implements the next unchecked item in `STATUS.md` for the current milestone. Writes code only, doesn't self-approve.
2. **`checker`** — runs what was built (executes the rule engine against a batch of synthetic inputs, hits API routes, opens generated DXF), checks for runtime errors, and diffs actual behavior against the plan/report's stated requirements (e.g. "does front door always attach to living," "is plot size proportional to room count"). Produces a findings list, doesn't fix anything itself.
3. **`fixer`** — takes the checker's findings only, fixes them, doesn't add scope.
4. **`reviewer`** — final pass: confirms the milestone genuinely satisfies the plan/report intent, updates `STATUS.md`, and states the next milestone.

I orchestrate these via the Agent tool per milestone. After each cycle, **I give you a plain-language recap of what was built and why** before moving on — that's the mechanism for the "collaborative, defensible" agreement, not a formality.

## Verification

- Rule engine: run the generator across a batch (e.g. 50-100) of varied synthetic room requirements; assert zero collisions, zero boundary violations, 100% hard-rule satisfaction (front door↔living, kitchen↔living, en-suite pairing) after solving.
- DXF: confirm output parses with `ezdxf` (Python, read-only sanity check) or opens cleanly in any DXF viewer.
- API: smoke-test each route with representative payloads.
- Frontend: manually run the dev server and click through requirement → generate → view (2D, 3D) → cost → DXF download, per this project's own `run` skill conventions once the app exists.
- Report: cross-check every claim in the rewritten methodology chapter against actual code/output, not aspirational language (the exact failure mode that caused the original report/code mismatch).
