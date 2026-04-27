# AI Factory Minimal Instruction Pack

## Creator (Required Minimum)

1. Output must be valid JSON array only.
2. Required fields per item:
   - `prompt`
   - `options` (length 2 or 4)
   - `correctIndex` (in range)
   - `studyBody` (`[principle] + [why] + [memory tip]`)
   - `subcategoryKey` (exact match)
   - `difficulty` (`easy|medium|hard`)
   - `questionType` (`conceptual|procedural|application`)
3. Batch distribution target: `30% conceptual / 30% procedural / 40% application`.
4. Arabic educational style optimized for active recall.

## Auditor (Required Minimum)

1. Validate only risks not guaranteed by local normalization/validators.
2. Return strict JSON object:
   - `summary: string`
   - `issues: string[]`
   - `requiresRefine: boolean`
3. No markdown fences.

## Refiner (Required Minimum)

1. Run only if gate indicates issues.
2. Preserve valid rows when possible; repair only problematic parts.
3. Return strict JSON array only.

## Gate Conditions

Refiner runs when any condition is true:

- `validationErrors.length > 0`
- `auditReport.issues.length > 0`
- `auditReport.requiresRefine === true`
