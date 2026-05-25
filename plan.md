# Implementation Plan

## Goal
Centralize all non-protocol-tunable literals (UI/LLM tuning/timeouts/evidence truncation/prompt persona) into a dedicated config module while preserving protocol-critical constants and keeping `npm test`/`npm pack --dry-run` deterministic.

## Tasks
1. **Add a dedicated config module with tunable defaults**
   - File: `src/plan-orchestrator-config.ts`
   - Changes:
     - Create `PLAN_ORCHESTRATOR_CONFIG` (and a `PlanOrchestratorConfig` type) as a pure TypeScript module (no fs/env reads; deterministic imports).
     - Include only *configurable candidates* from the scout output:
       - `llm.strictJsonRepairPrompt` = `"Fix to strict JSON schema"`
       - `llm.defaultStrictJsonRepairRetries` = `2`
       - `slashBridge.defaultTimeoutMs` = `15000`
       - `resumeEvidence.maxEvidenceChars` = `8000`
       - UI/UX strings & formatting:
         - widget key (`"plan-orchestrator"`), placement (`"aboveEditor"`)
         - widget heading (`"Plan orchestrator"`), goal label prefix (`"Goal: "`)
         - description indent (`"   "`) and command indent (`"   "`)
         - usage/help notification, interactive-UI required notification
         - editor title/prefill (`"Refine plan"`, `""`)
         - confirm title/message (`"Start execution?"`, `"Execute the approved plan as a single foreground run?"`)
         - completion notifications (`"Plan completed"`, `"Resume completed"`)
       - Prompt *persona/section header* strings that are explicitly **not** protocol-enforcing (keep the strict JSON/schema/grammar lines hard-coded in their current builders):
         - `initialPlan.personaLine`, `initialPlan.userRequestLabel`
         - `refinedPlan.introLine`, `refinedPlan.currentRequestLabel`, `refinedPlan.currentPlanJsonLabel`, `refinedPlan.refinementInstructionsLabel`
         - `resumePlan.cursorLabelPrefix`, `resumePlan.originalPlanJsonLabel`, `resumePlan.completedPrefixEvidenceLabel`, `resumePlan.failedCommandEvidenceLabel`
     - Explicitly **do not** place these in config (to avoid compatibility breaks):
       - `PLAN_SCHEMA_VERSION`, cursor sentinel semantics, snapshot/cursor persistence identifiers
       - slash-bridge event names (`subagent:slash:*`)
       - resume-evidence protocol identifiers (`customType === "subagent-slash-result"`, markdown heading `"## Subagent result"`)
       - planner message routing contract (`customType: "plan-orchestrator-planner"`, `triggerTurn/deliverAs`, etc.)
       - command parsing/grammar rules and `--bg` rejection rules
       - protocol-enforcing prompt lines (strict JSON only, schemaVersion 1, /chain|/parallel command start, reject --bg; allow --fork, strict remainder prompt “Return only JSON.”)
   - Acceptance:
     - `src/plan-orchestrator-config.ts` is committed under `src/` and is importable via ESM (use explicit `.ts` extension in imports from other files).
     - All default values exactly match the existing literal strings/numbers currently used in code.

2. **Refactor strict JSON repair defaults to read from config while preserving exported constants**
   - File: `src/planner-loop.ts`
   - Changes:
     - Import `PLAN_ORCHESTRATOR_CONFIG`.
     - Keep the *existing exports* stable for tests/external imports:
       - `export const STRICT_JSON_REPAIR_PROMPT` should remain exported from this file and equal `PLAN_ORCHESTRATOR_CONFIG.llm.strictJsonRepairPrompt`.
       - `export const DEFAULT_STRICT_JSON_REPAIR_RETRIES` should remain exported from this file and equal `PLAN_ORCHESTRATOR_CONFIG.llm.defaultStrictJsonRepairRetries`.
     - Ensure `toPromptWithRepair()` appends the same repair prompt text with the same newline structure.
   - Acceptance:
     - `test/planner-loop.test.ts` passes without modifying its imports/assertions.
     - `STRICT_JSON_REPAIR_PROMPT` string match expectations remain identical.

3. **Refactor slash-bridge default timeout to read from config**
   - File: `src/slash-bridge-executor.ts`
   - Changes:
     - Import `PLAN_ORCHESTRATOR_CONFIG`.
     - Replace the hard-coded default `15_000` in `createSlashBridgeExecutor` with `PLAN_ORCHESTRATOR_CONFIG.slashBridge.defaultTimeoutMs`.
     - Keep the exported slash-bridge event name constants (`SLASH_SUBAGENT_REQUEST_EVENT`, etc.) unchanged (do not move them to config).
   - Acceptance:
     - `test/slash-bridge-executor.test.ts` continues to pass.
     - No protocol event name strings change.

4. **Refactor resume evidence truncation length to read from config**
   - File: `src/resume-evidence.ts`
   - Changes:
     - Import `PLAN_ORCHESTRATOR_CONFIG`.
     - Replace the hard-coded `8000` in `truncateEvidence()` with `PLAN_ORCHESTRATOR_CONFIG.resumeEvidence.maxEvidenceChars`.
     - Keep resume evidence protocol matching unchanged:
       - `customType === "subagent-slash-result"`
       - markdown heading extraction based on `"## Subagent result"` and `## ...` termination.
   - Acceptance:
     - `test/resume-evidence.test.ts` passes (including the exact “length === 8000” assertion).

5. **Refactor UI widget strings and non-protocol prompt persona/labels to read from config**
   - File: `src/plan-orchestrator-extension.ts`
   - Changes:
     - Import `PLAN_ORCHESTRATOR_CONFIG`.
     - UI/widget:
       - Replace hard-coded widget key (`"plan-orchestrator"`), placement (`"aboveEditor"`), and render formatting literals with config values.
       - Replace hard-coded UI notifications (usage/help, interactive-UI-required, plan completed/resume completed) with config values.
       - Replace editor/confirm title/message literals with config values.
     - Prompt builders:
       - Keep the *protocol-enforcing lines* exactly as-is (do not parameterize or alter):
         - `"Return strict JSON only."`
         - `"Use schemaVersion 1 and include only goal and steps."`
         - `"Every command must start with /chain or /parallel."`
         - `"Reject --bg; allow --fork."`
         - (and any remainder strict “Return only JSON.” / remainder-schema strictness)
       - Parameterize only *persona/section header* strings (e.g., “You are the dedicated planner...”, “User request:”, refined-plan intro/labels) using config.
     - Ensure function exports remain unchanged:
       - `buildInitialPlanPrompt`, `buildRefinedPlanPrompt`, `renderPlanWidget` signatures/exports unchanged.
   - Acceptance:
     - `test/index.test.ts` passes without updating the expected widget content/keys.
     - No protocol strings (customType/event names/schema semantics) are altered.

6. **Refactor remainder prompt section labels (non-protocol) to read from config**
   - File: `src/resume-plan.ts`
   - Changes:
     - Import `PLAN_ORCHESTRATOR_CONFIG`.
     - In `buildResumeRemainderPrompt()` replace only non-protocol labels with config values:
       - cursor label prefix
       - “Original plan JSON:”, “Completed prefix evidence:”, “Failed command evidence:”
     - Keep strict remainder protocol lines unchanged:
       - `"Adapt the remainder of this plan only. Return strict JSON matching the remainder schema."`
       - `"Return only JSON."`
   - Acceptance:
     - `test/resume-plan.test.ts` passes (regex assertions for evidence content still succeed).

7. **Add a config-defaults unit test to lock in expected defaults (deterministic safety net)**
   - File: `test/config-defaults.test.ts` (new)
   - Changes:
     - Import `PLAN_ORCHESTRATOR_CONFIG` and assert the defaults equal the historical literals/numbers:
       - strict JSON repair prompt
       - strict JSON repair retries
       - slash-bridge default timeout
       - resume evidence max chars
       - UI widget heading/indents (at least one or two representative values)
   - Acceptance:
     - New test passes and fails if defaults drift.

8. **Verification: run test suite + packaging dry-run determinism check**
   - File: N/A (commands)
   - Changes:
     - Run `npm test`.
     - Run `npm pack --dry-run` and verify:
       - output is deterministic across runs
       - tarball file set stays minimal (no new top-level files; config lives under `src/`)
       - config file appears under `src/*` in the listing.
   - Acceptance:
     - `npm test` is green.
     - `npm pack --dry-run` consistently includes the same file list (allowing only the expected addition of the new config file under `src/`).

## Files to Modify
- `src/planner-loop.ts` - source exported strict JSON repair constants from config.
- `src/slash-bridge-executor.ts` - use config default timeout when `options.timeoutMs` is not provided.
- `src/resume-evidence.ts` - use config default evidence truncation length.
- `src/plan-orchestrator-extension.ts` - use config for UI strings/formatting and non-protocol prompt persona/labels.
- `src/resume-plan.ts` - use config for non-protocol remainder prompt section labels.

## New Files
- `src/plan-orchestrator-config.ts` - dedicated module exporting `PLAN_ORCHESTRATOR_CONFIG` defaults for tunables.
- `test/config-defaults.test.ts` - locks in expected default values for deterministic behaviour.

## Dependencies
- Task 1 must be completed before Tasks 2–6 can import and consume config.
- Task 7 depends on Task 1 (config module) and therefore indirectly on Tasks 2–6 for successful overall compile/test.
- Task 8 depends on all code/test changes (Tasks 2–7).

## Risks
- **Accidental protocol breakage**: moving/changing protocol-critical strings (schema/cursor identifiers, slash-bridge event names, resume-evidence customType/heading markers, command parsing constraints, planner message routing contract, or strict prompt lines) can break compatibility. Mitigation: explicitly list protocol-critical strings in Task 1 and keep them hard-coded in their current locations.
- **Prompt formatting drift**: refactors that alter join delimiters/line breaks could affect LLM output quality even when strings are unchanged. Mitigation: keep prompt builder logic/structure identical; only replace string literals with config values.
- **Exact UI snapshot mismatches**: `renderPlanWidget()` spacing is asserted via deepEqual in `test/index.test.ts`. Mitigation: ensure config defaults preserve exact spacing (indents and blank lines).
- **Export stability for tests**: tests import `STRICT_JSON_REPAIR_PROMPT` from `src/planner-loop.ts`. Mitigation: keep the exports and values stable in that module (Task 2).
- **Packaging determinism**: adding config files outside `src/` or changing `package.json.files` could alter `npm pack --dry-run` output. Mitigation: place config under `src/` and avoid changing `package.json.files`.