/**
 * Lightweight checks for Refiner gating + patch parsing (no API calls).
 * Run: npx tsx server/scripts/verifyRefinerScenarios.ts
 */
import assert from "node:assert/strict";
import { tryParseRefinerPatches, extractJsonArray, normalizeFactoryQuestion } from "../services/aiFactory/utils";

function shouldRunFactoryRefiner(validationErrorsCount: number, requiresRefine: boolean): boolean {
  return validationErrorsCount > 0 || requiresRefine;
}

assert.equal(shouldRunFactoryRefiner(0, false), false, "issues-only path must not run refiner");
assert.equal(shouldRunFactoryRefiner(0, true), true);
assert.equal(shouldRunFactoryRefiner(2, false), true, "schema validation errors still run refiner");
assert.equal(shouldRunFactoryRefiner(1, true), true);

const patchJson = `{"patches":[{"index":1,"question":{"prompt":"Q2","options":["a","b"],"correctIndex":0,"studyBody":"x+y+z","subcategoryKey":"sub","difficulty":"medium","questionType":"conceptual"}}]}`;
const parsed = tryParseRefinerPatches(patchJson);
assert.ok(parsed);
assert.equal(parsed!.patches.length, 1);
const q = normalizeFactoryQuestion(parsed!.patches[0]!.question, 1);
assert.equal(q.prompt, "Q2");

const arrOnly = `[{"prompt":"A","options":["x","y"],"correctIndex":0,"studyBody":"p+w+t","subcategoryKey":"s","difficulty":"easy","questionType":"procedural"}]`;
assert.equal(tryParseRefinerPatches(arrOnly), null);
assert.ok(extractJsonArray(arrOnly));

console.log("verifyRefinerScenarios: ok");
