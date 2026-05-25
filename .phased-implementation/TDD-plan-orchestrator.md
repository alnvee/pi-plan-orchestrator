# TDD Plan for `pi-plan-orchestrator`

Source of truth: `./PRD-plan-orchestrator.md`

This document turns the PRD into a **behavior-first, vertical-slice TDD plan**.
It is not a full implementation spec. Its job is to answer:

- **What public interfaces should exist?**
- **Which behaviors matter most?**
- **What order should we implement them in with RED → GREEN → REFACTOR?**
- **Where should we prefer deep-module tests vs thin integration tests?**

---

## 1. Public Interfaces to Stabilize

The implementation should be testable through a small number of public interfaces.
These are the interfaces the tests should target.

### User-facing interfaces

1. **`/plan-orchestrator`**
   - Generates a strict JSON plan.
   - Shows the plan and exact slash commands in the UI.
   - Accepts refinement instructions.
   - Requires one explicit approval to start execution.

2. **`/plan-orchestrator resume`**
   - Loads the active cursor and active plan snapshot.
   - Immediately generates a remainder-only plan.
   - Merges the adapted remainder.
   - Continues execution from the cursor.

### Extension-facing public modules

These are not “private helpers”; they are the intended stable seams for tests.

1. **Plan schema validation**
   - `validatePlanJson(value)`
   - `validateRemainderJson(value)`
   - `validateCursorJson(value)`

2. **Command compilation + validation**
   - A public function that accepts a stored command string and returns structured pi-subagents execution params, or a validation error.
   - Example shape: `compileStoredCommand(command: string)`

3. **Sequential execution engine**
   - A public function that accepts a plan, a starting cursor, and an executor dependency.
   - Executes commands in order, stops on first failure, and returns updated cursor + execution outcome.
   - Example shape: `runPlan(plan, startCursor, deps)`

4. **Resume evidence extraction**
   - A public function that accepts session entries and a cursor and returns the evidence bundle used for adaptation.
   - Example shape: `collectResumeEvidence(entries, cursor)`

5. **Remainder merge**
   - `mergePlanRemainder(original, cursor, remainder)`
   - This already exists and is the current deep module foundation.

6. **Plan session state**
   - A public function or module boundary responsible for:
     - saving/loading the active plan snapshot separately from `appendEntry`
     - saving/loading the resume cursor
   - Example shape: `loadPlanSessionState()` / `savePlanSessionState()`

7. **Planner/refiner loop**
   - A public function that requests plan JSON or remainder JSON from the model and applies the repair loop:
     - initial generation
     - “Fix to strict JSON schema” retry 1
     - retry 2
     - hard stop on exhaustion
   - Example shape: `generateValidPlanJson(...)` / `generateValidRemainderJson(...)`

---

## 2. What We Should Test First

From the PRD, the most important behaviors are:

### P0 — Must work before the extension is useful

1. Valid plan/remainder/cursor JSON is accepted; invalid JSON is rejected.
2. Stored commands are restricted to `/chain` and `/parallel`.
3. `--bg` is rejected; `--fork` is allowed.
4. Command strings can be compiled into structured pi-subagents slash-bridge params.
5. Execution runs sequentially in array order.
6. Execution stops on the first failure.
7. The cursor points to the failed/uncompleted command.
8. `/parallel` fails as a whole if any child task fails.
9. Resume evidence includes completed-prefix outputs plus the failed command output.
10. Remainder merge preserves completed command strings and failed-step metadata exactly.
11. Resume auto-adapts immediately on `/plan-orchestrator resume`.
12. Retry exhaustion surfaces an error and leaves the cursor unchanged.

### P1 — Important workflow behaviors

13. `/plan-orchestrator` is UI-first and does not auto-execute initially.
14. The user sees the exact slash commands before execution.
15. The user can refine in natural language through the editor.
16. Execution starts only after one explicit approval for the full run.
17. The active plan snapshot is stored separately from `appendEntry` and can be reloaded on resume.

### P2 — Confidence / polish

18. Progress and result messages remain stable enough to support evidence extraction.
19. UI state clearly communicates failure location and resume path.
20. The thin extension adapter stays thin; complexity lives in deep modules.

---

## 3. Testing Strategy

### What to prefer

- **Integration-style tests** for behavior-heavy modules.
- **Deep-module tests** where a complex contract can be hidden behind a small interface.
- **In-memory fakes** only at true boundaries:
  - planner/refiner model calls
  - slash-bridge executor
  - UI prompt/confirm/editor calls
  - session state storage
  - session entry history

### What to avoid

- No tests that assert internal helper calls.
- No tests that snapshot incidental JSON formatting.
- No tests coupled to implementation-specific event timing.
- No broad “write every test file first” pass.

### Test command

Current repo command:

```bash
npm test
```

Current implementation already has a passing deep-module test suite for `mergePlanRemainder(...)`.
That should stay green throughout the rest of the work.

---

## 4. Proposed File/Test Boundaries

This is a suggested target structure, not a requirement to create all files up front.

### Existing

- `src/remainder-merge.ts`
- `test/remainder-merge.test.ts`
- `src/plan-schemas.ts`

### Likely next public modules

- `src/command-compiler.ts`
- `src/plan-execution.ts`
- `src/resume-evidence.ts`
- `src/plan-session-state.ts`
- `src/planner-loop.ts`
- `src/index.ts`

### Likely test files

- `test/plan-schemas.test.ts`
- `test/command-compiler.test.ts`
- `test/plan-execution.test.ts`
- `test/resume-evidence.test.ts`
- `test/plan-session-state.test.ts`
- `test/planner-loop.test.ts`
- `test/index.test.ts`

Do **not** create all of these tests at once. Add them only as each vertical slice needs them.

---

## 5. Tracer Bullet Order (Vertical Slices)

The slices below are ordered to keep each RED → GREEN cycle small while still moving toward the real user workflow.

## Slice 0 — Keep the current deep module green

### Behavior
`mergePlanRemainder(...)` preserves completed prefix commands and failed-step metadata while rewriting only the allowed remainder.

### Status
Already implemented and tested.

### Rule
Do not break existing `test/remainder-merge.test.ts` while adding new behavior elsewhere.

---

## Slice 1 — Strict JSON contract for plans/remainders/cursor

### First behavior to test
A minimal valid plan JSON is accepted, and obvious schema violations are rejected.

### Public interface
- `validatePlanJson(value)`
- `validateRemainderJson(value)`
- `validateCursorJson(value)`

### First RED test
`validatePlanJson accepts a minimal valid plan`

### GREEN target
Implement the minimum schema validation needed to accept:

```json
{
  "schemaVersion": 1,
  "goal": "ship feature",
  "steps": [
    {
      "title": "Draft plan",
      "commands": ["/chain planner \"draft a plan\""]
    }
  ]
}
```

### Next tests in this slice
1. Reject additional top-level properties and additional properties inside `steps[]`/cursor objects.
2. Reject wrong `schemaVersion` (plan and remainder).
3. Reject empty `steps`.
4. Reject empty `commands`.
5. Reject wrong types (e.g., non-string `goal`/`title`, non-string command items, non-string `description`).
6. Reject invalid `commands[]` values that do not start with `/chain` or `/parallel` (schema-level allowlist).
7. Cursor validation: accept `{ stepIndex: -1, commandIndex: -1 }` as “no active cursor”, and reject out-of-range / non-integer cursor values.
8. Reject plan/remainder schema cross-use.

### Refactor note
If command allowlist validation makes schema code noisy, move command-string validation behind a small public function.

---

## Slice 2 — Command compiler + allowlist boundary

### First behavior to test
A stored `/chain ...` command can be compiled into structured execution params, while invalid commands are rejected before execution. The compiler should support the full relevant pi-subagents `/chain` and `/parallel` grammar that the planner stores in `commands[]`, not a restricted subset.

### Public interface
- `compileStoredCommand(command)`

### First RED test
`compileStoredCommand compiles a valid /chain command`

### GREEN target
Support one valid `/chain` example end-to-end through the compiler.

### Next tests in this slice
1. Compile a valid `/parallel` command.
2. Reject commands that do not start with `/chain` or `/parallel`.
3. Reject any command containing `--bg`.
4. Allow `--fork`.
5. Preserve enough information to execute through the slash bridge.
6. Cover representative full relevant pi-subagents `/chain` and `/parallel` grammar examples (not a restricted subset) that match what the planner stores in `commands[]`.

### Refactor note
The compiler should be a deep module: small public API, complex parsing hidden inside.

---

## Slice 3 — Sequential execution stops on first failure

### First behavior to test
Given a valid plan and a fake executor, the engine executes commands in array order and stops when one fails.

### Public interface
- `runPlan(plan, startCursor, deps)`

### First RED test
`runPlan executes commands sequentially and stops on first failure`

### GREEN target
Minimum engine behavior:
- run command 0
- run command 1
- if command 1 fails, stop
- return cursor pointing to that failed command

### Next tests in this slice
1. Success path clears/sets the “no active cursor” state.
2. Cursor points to the first uncompleted command.
3. Commands in later steps are not executed after a failure.
4. `/parallel` counts as failed if any child task fails.
5. Bridge-level errors also count as failure.

### Refactor note
Keep the event-bus transport behind the injected executor dependency. The loop itself should remain deterministic and easy to test.

---

## Slice 4 — Planner/refiner repair loop

### First behavior to test
If the planner returns invalid JSON first, the system retries with “Fix to strict JSON schema” and accepts the repaired output.

### Public interface
- `generateValidPlanJson(...)`
- `generateValidRemainderJson(...)`

### First RED test
`generateValidPlanJson retries once with Fix to strict JSON schema when initial output is invalid`

### GREEN target
Support one repair round-trip.

### Next tests in this slice
1. Succeeds without retry when JSON is already valid.
2. Retries when JSON parses but fails the TypeBox schema (wrong shape / wrong `schemaVersion` / wrong field types).
3. Same repair prompt (“Fix to strict JSON schema”) is used for both plan generation and remainder-only generation (`generateValidRemainderJson`).
4. Stops after 2 repair retries.
5. On retry exhaustion, returns an actionable error.
6. Retry exhaustion during remainder generation preserves the current cursor unchanged in the resume path.

### Refactor note
Keep the repair-loop transcript logic separate from UI code.

---

## Slice 5 — Evidence extraction for resume

### First behavior to test
Evidence extraction returns completed-prefix outputs plus the failed command output, using only final `subagent-slash-result` entries whose content includes `## Subagent result`.

### Public interface
- `collectResumeEvidence(entries, cursor)`

### First RED test
`collectResumeEvidence ignores placeholders and returns completed-prefix evidence plus failed-command evidence`

### GREEN target
Support chronological mapping between executed stored commands and final slash-result entries.

### Next tests in this slice
1. Ignore entries without `customType === "subagent-slash-result"`.
2. Ignore placeholder slash-result content and ignore any `subagent-slash-result` entries whose content does not include `## Subagent result`; extract only the `## Subagent result` section from qualifying final messages.
3. Truncate each extracted evidence blob to ~8000 chars.
4. Preserve chronological mapping from executed command index to final result entry.

### Refactor note
Do not couple tests to the full session-manager implementation; use realistic entry objects that match the public session-entry shape.

---

## Slice 6 — Resume adaptation merges and continues

### First behavior to test
`/plan-orchestrator resume` loads cursor + plan snapshot, adapts the remainder, merges it, and resumes from the cursor.

### Public interface
- `resumePlan(...)` or the equivalent public resume workflow entrypoint

### First RED test
`resumePlan merges adapted remainder into the active plan and resumes execution from the failed command`

### GREEN target
Minimum flow:
- load cursor
- load active plan snapshot
- collect evidence
- generate valid remainder JSON
- merge with `mergePlanRemainder(...)`
- continue execution from the cursor

### Next tests in this slice
1. No editor prompt is shown during resume.
2. Failed-step metadata remains unchanged after merge.
3. Completed prefix commands remain unchanged after merge.
4. Later steps may be fully replaced.
5. Retry exhaustion during remainder generation stops and preserves cursor.

### Refactor note
The resume workflow should orchestrate other public modules, not re-implement their logic.

---

## Slice 7 — UI-first planning flow

### First behavior to test
`/plan-orchestrator` shows a generated plan in the UI and does not start execution until the user explicitly approves.

### Public interface
- `/plan-orchestrator` command handler via `src/index.ts`

### First RED test
`/plan-orchestrator shows the plan before execution and waits for approval`

### GREEN target
Minimum flow:
- generate valid plan
- display it
- wait for user decision
- only start execution after approval

### Next tests in this slice
1. The exact stored slash commands are shown in the UI.
2. The editor can supply refinement instructions.
3. Refined JSON must validate before execution begins.
4. One approval starts the whole run; there is no per-command approval loop.

### Refactor note
Keep the command handler thin. UI orchestration should call into already-tested public modules.

---

## Slice 8 — Session state contract

### First behavior to test
The extension stores only the cursor in `appendEntry`, while storing the active plan snapshot separately for resume.

### Public interface
- `savePlanSessionState(...)`
- `loadPlanSessionState(...)`

### First RED test
`savePlanSessionState writes only the cursor to appendEntry and stores the active plan snapshot separately`

### GREEN target
Support the minimal persistence contract required by the PRD.

### Next tests in this slice
1. Successful completion clears the cursor.
2. Resume loads the same active plan snapshot that execution previously stored.
3. Cursor-only `appendEntry` payload never accumulates extra progress fields.

### Refactor note
Treat storage as a boundary. Test behavior, not the exact serialization mechanism.

---

## 6. Suggested Test Names

These are intentionally behavior-oriented. Use them as seeds, not as a checklist to write all at once.

- `validatePlanJson accepts a minimal valid plan`
- `validatePlanJson rejects additional top-level properties`
- `compileStoredCommand rejects --bg commands`
- `compileStoredCommand allows --fork`
- `runPlan executes commands in array order`
- `runPlan stops on first failure and returns the failed cursor`
- `runPlan treats any child failure in /parallel as a command failure`
- `generateValidPlanJson retries invalid output up to two times`
- `collectResumeEvidence ignores placeholders and truncates final outputs`
- `resumePlan adapts the remainder and resumes from the failed cursor`
- `/plan-orchestrator shows the exact stored commands before execution`
- `/plan-orchestrator waits for a single approval before starting the run`
- `/plan-orchestrator resume skips the editor and resumes immediately`

---

## 7. Implementation Notes That Matter to TDD

These are design constraints from the PRD that should shape tests.

1. **The slash-bridge path is mandatory**
   - `sendUserMessage()` is not the execution path.
   - Tests should target the command compiler + executor boundary, not a fake slash expansion path.

2. **The JSON contract is strict**
   - Validation should happen before execution or merge.
   - Tests should assert rejection of malformed structures.

3. **The plan snapshot storage is part of the public behavior**
   - Cursor-only `appendEntry` is not enough by itself.
   - Resume depends on separately stored active plan state.

4. **“Byte-for-byte” is semantic, not serializer-level**
   - Tests should assert exact `commands[]` string equality and exact failed-step metadata equality.
   - Tests should not assert pretty-printing or JSON whitespace.

5. **The repair loop is a behavior, not an implementation detail**
   - Tests should describe the retry semantics the user cares about.

---

## 8. Current Repo Status

Already present:

- `src/remainder-merge.ts`
- `test/remainder-merge.test.ts`
- `src/plan-schemas.ts`
- `PRD-plan-orchestrator.md`

Known current implementation note:

- `src/plan-schemas.ts` exists, but schema/import/runtime details should be validated in the first TDD slice before expanding into downstream behavior.

---

## 9. Recommended Start Point

If implementation starts now, the next RED → GREEN step should be:

1. **Write** `test/plan-schemas.test.ts`
2. First test: **`validatePlanJson accepts a minimal valid plan`**
3. Make it pass with the smallest possible fix
4. Add the next failing schema-behavior test

Why start there?

- The whole product depends on a strict JSON contract.
- The repo already has partial schema code.
- It is the smallest behaviorally important surface after the existing merge module.

After that, move immediately to:

- `compileStoredCommand(...)`
- `runPlan(...)`
- `collectResumeEvidence(...)`
- resume flow
- thin `/plan-orchestrator` adapter

---

## 10. Done Means

The TDD plan is complete when the implementation has:

- behavior-focused tests around each public module boundary
- a thin extension adapter in `src/index.ts`
- deep modules for parsing, execution, evidence extraction, and merge
- one-approval UI-first flow for `/plan-orchestrator`
- immediate adaptation flow for `/plan-orchestrator resume`
- no test suite that depends on private helper structure
