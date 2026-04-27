# AI Factory Prompt Architecture

## Current Layer Contract (Before Redesign)

- `Architect` emits a long natural-language prompt that already includes schema and policy rules.
- `Creator` receives the full architect text and appends another long rule list.
- `Auditor` receives full generated questions plus another long checklist.
- `Refiner` receives full generated questions again plus audit summary/issues.

This creates repeated constraints and high prompt-token pressure across all layers.

## Overprompting Sources

1. Repeated policy text across all layers (`JSON-only`, schema fields, distribution, studyBody format).
2. Full question payload duplication (`Auditor` then `Refiner`).
3. Refiner invocation even when creator output is already acceptable.
4. Reasoning-level settings in review layers inflate thoughts tokens without proportional output gain.

## Redesign Contract

- `Architect`: domain brief only (topic-specific misconceptions, focus points, no full schema restatement).
- `Creator`: single source of generation constraints.
- `Auditor`: risk-focused audit only for checks not guaranteed by local validators.
- `Refiner`: conditional layer; executes only when gate condition is true.

## Prompt Constraint Pack

Centralized shared constraints:

- Schema validity (`prompt/options/correctIndex/studyBody/subcategoryKey/difficulty/questionType`).
- Distribution target (`30/30/40` conceptual/procedural/application).
- Study-body micro-lesson format.
- Strict JSON output with no markdown fences.

These constraints should be referenced once by creator and reused by other layers only when strictly needed.
