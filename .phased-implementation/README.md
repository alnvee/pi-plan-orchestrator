# Phased Implementation Plan — `pi-plan-orchestrator`

Source documents:
- `../PRD-plan-orchestrator.md`
- `../TDD-plan-orchestrator.md`

This document turns the PRD + TDD documents into an execution-ready implementation plan.
Each phase has:

- a narrow implementation scope
- the tests that must be written or expanded in that phase
- explicit **gates** that must pass before the next phase begins

## Working rules for all phases

1. **No phase may close while RED.**
2. **Each phase starts with the smallest useful failing test** for that phase’s main behavior.
3. **Each phase ends with two gates:**
   - **Targeted gate:** the tests introduced or extended in that phase pass
   - **Full-suite gate:** `npm test` passes
4. **Do not start a later phase early** because it “seems obvious.”
5. **Keep `src/index.ts` thin**; complexity belongs in deep modules.
6. **Preserve the existing `mergePlanRemainder(...)` contract** throughout all later phases.

---

## Phase 0 — Baseline stabilization and strict contract foundation

### Goal
Stabilize the repo around the strict JSON contract so later work has a reliable base.
This phase also protects the already-implemented remainder merge module.

### Why this phase comes first
Everything else depends on:
- valid plan JSON
- valid remainder JSON
- valid cursor JSON
- an implementation/runtime setup that can actually run the schema validators in tests

### Scope
1. Keep `src/remainder-merge.ts` and `test/remainder-merge.test.ts` green.
2. Finish `src/plan-schemas.ts` so it matches the PRD contract:
   - `schemaVersion`, `goal`, `steps`
   - remainder schema with `schemaVersion`, `steps`
   - cursor schema with `stepIndex`, `commandIndex`
   - `-1/-1` sentinel allowed for “no active cursor”
   - additional properties forbidden
   - `commands[]` limited to `/chain` or `/parallel`
3. Resolve current TypeBox import/runtime issues so the schema validators work in the repo’s test environment.
4. Align package/runtime declarations only as needed to make this contract executable in tests.

### Files expected to change
- `src/plan-schemas.ts`
- `package.json` (only if needed for schema/runtime correctness)
- `tsconfig.json` (only if needed for schema/runtime correctness)
- `test/plan-schemas.test.ts` (new)
- `test/remainder-merge.test.ts` (only if an existing contract needs tightening, not broad refactors)

### Tests to add first (RED → GREEN)
1. `validatePlanJson accepts a minimal valid plan`
2. `validateRemainderJson accepts a minimal valid remainder`
3. `validateCursorJson accepts {-1, -1} as no active cursor`

### Tests to complete before phase exit
- `validatePlanJson rejects additional top-level properties`
- `validatePlanJson rejects additional properties inside steps`
- `validatePlanJson rejects wrong schemaVersion`
- `validatePlanJson rejects empty steps`
- `validatePlanJson rejects empty commands`
- `validatePlanJson rejects commands that do not start with /chain or /parallel`
- `validateRemainderJson rejects plan-shaped input`
- `validatePlanJson rejects remainder-shaped input`
- `validateCursorJson rejects non-integer cursor values`
- `validateCursorJson rejects invalid sentinel combinations or out-of-range values`
- Existing `mergePlanRemainder(...)` tests remain green

### Gate to enter Phase 1
**Targeted gate**
```bash
node --experimental-strip-types --test test/plan-schemas.test.ts test/remainder-merge.test.ts
```

**Full-suite gate**
```bash
npm test
```

### Exit criteria
- Strict schema validators behave as specified in the PRD
- Current deep merge module is still green
- The repo can run schema tests cleanly without unresolved import/runtime blockers

---

## Phase 1 — Stored command compiler and allowlist boundary

### Goal
Create the public command-compiler boundary that turns stored slash command strings into structured pi-subagents execution params.

### Why this phase comes second
The execution engine should not parse raw slash strings itself.
A stable compiler boundary reduces complexity in later execution and resume phases.

### Scope
1. Add a public compiler module, e.g. `src/command-compiler.ts`.
2. Support the **full relevant** pi-subagents `/chain` and `/parallel` grammar that the planner is allowed to store in `commands[]`.
3. Enforce orchestrator-specific rules:
   - reject any command containing `--bg`
   - allow `--fork`
   - reject commands outside `/chain` and `/parallel`
4. Return structured execution params that the slash-bridge executor can consume.

### Files expected to change
- `src/command-compiler.ts` (new)
- `test/command-compiler.test.ts` (new)
- `src/plan-schemas.ts` (only if command validation boundary needs a clean shared helper)

### Tests to add first (RED → GREEN)
1. `compileStoredCommand compiles a valid /chain command`
2. `compileStoredCommand rejects commands outside /chain and /parallel`

### Tests to complete before phase exit
- `compileStoredCommand compiles a valid /parallel command`
- `compileStoredCommand rejects any command containing --bg`
- `compileStoredCommand allows --fork`
- `compileStoredCommand preserves enough structure for slash-bridge execution`
- Representative full-grammar examples pass for stored `/chain` commands
- Representative full-grammar examples pass for stored `/parallel` commands
- Invalid grammar surfaces actionable compiler errors

### Gate to enter Phase 2
**Targeted gate**
```bash
node --experimental-strip-types --test test/command-compiler.test.ts test/plan-schemas.test.ts test/remainder-merge.test.ts
```

**Full-suite gate**
```bash
npm test
```

### Exit criteria
- Raw stored commands are no longer an unstructured string problem at execution time
- The compiler enforces `/chain` + `/parallel` allowlisting and `--bg` rejection centrally

---

## Phase 2 — Sequential execution engine and slash-bridge transport

### Goal
Build the core execution loop that runs compiled commands sequentially, stops on first failure, and reports an accurate cursor.

### Why this phase comes third
Once command compilation is stable, the executor can focus only on ordering, failure semantics, and bridge integration.

### Scope
1. Add a public execution module, e.g. `src/plan-execution.ts`.
2. Add a slash-bridge execution adapter boundary that:
   - emits request events with unique request IDs
   - waits for matching response events
   - optionally handles updates for UI status
3. Define failure semantics exactly as in the PRD:
   - an explicit bridge-level error response from the slash-bridge adapter = command failure
   - any non-zero subresult `exitCode` = command failure
   - any child failure in `/parallel` fails the whole stored command
4. Update/return the cursor so it points to the first failed or uncompleted command.
5. Clear to `-1/-1` only when execution fully succeeds.

### Files expected to change
- `src/plan-execution.ts` (new)
- `src/slash-bridge-executor.ts` or equivalent (new)
- `test/plan-execution.test.ts` (new)
- `test/slash-bridge-executor.test.ts` (new or folded into execution tests)

### Tests to add first (RED → GREEN)
1. `runPlan executes commands sequentially in array order`
2. `runPlan stops on first failure and returns the failed cursor`

### Tests to complete before phase exit
- `runPlan does not execute later commands after a failure`
- `runPlan clears the cursor to no active cursor on full success`
- `runPlan treats bridge-level errors as failure`
- `runPlan treats any child failure in /parallel as failure`
- `runPlan sets cursor.stepIndex and cursor.commandIndex to the exact failing (uncompleted) command indices (not the next command)`
- `slash bridge executor matches request/response by requestId`
- `slash bridge executor surfaces actionable transport errors`

### Gate to enter Phase 3
**Targeted gate**
```bash
node --experimental-strip-types --test test/plan-execution.test.ts test/slash-bridge-executor.test.ts test/command-compiler.test.ts test/plan-schemas.test.ts test/remainder-merge.test.ts
```

**Full-suite gate**
```bash
npm test
```

### Exit criteria
- There is a deterministic foreground execution engine
- Failure semantics match the PRD exactly
- The executor can drive pi-subagents through the slash bridge instead of `sendUserMessage()`

---

## Phase 3 — Planner/refiner strict-JSON repair loop

### Goal
Make plan and remainder generation robust by enforcing the strict JSON contract with up to two repair retries.

### Why this phase comes now
The system needs reliable validated plan JSON before the UI flow and before resume adaptation can be trusted.

### Scope
1. Add a public planner loop module, e.g. `src/planner-loop.ts`.
2. Implement:
   - initial generation
   - validation against the proper schema
   - “Fix to strict JSON schema” retry 1
   - retry 2
   - hard stop after retry exhaustion
3. Support both:
   - full plan generation
   - remainder-only plan generation
4. Preserve cursor state unchanged when remainder generation exhausts retries.

### Files expected to change
- `src/planner-loop.ts` (new)
- `test/planner-loop.test.ts` (new)

### Tests to add first (RED → GREEN)
1. `generateValidPlanJson accepts valid JSON without retry`
2. `generateValidPlanJson retries with Fix to strict JSON schema after invalid output`

### Tests to complete before phase exit
- `generateValidPlanJson stops after two repair retries`
- `generateValidPlanJson returns actionable validation errors on exhaustion`
- `generateValidRemainderJson uses the same repair prompt behavior`
- `generateValidRemainderJson preserves cursor unchanged when retries are exhausted in resume flow`
- `planner loop distinguishes JSON-parse failure from schema-shape failure without weakening validation`

### Gate to enter Phase 4
**Targeted gate**
```bash
node --experimental-strip-types --test test/planner-loop.test.ts test/plan-execution.test.ts test/command-compiler.test.ts test/plan-schemas.test.ts test/remainder-merge.test.ts
```

**Full-suite gate**
```bash
npm test
```

### Exit criteria
- Plan generation and remainder generation both enforce the same strict validation contract
- Retry exhaustion behavior matches the PRD

---

## Phase 4 — Session state, evidence extraction, and resume core

### Goal
Implement the session-backed resume system: cursor persistence, active plan snapshot storage, evidence extraction, remainder generation, merge, and resume continuation.

### Why this phase comes now
Resume depends on previously completed phases:
- schemas
- command compiler
- execution engine
- repair loop
- merge module

### Scope
1. Add plan session state boundary, e.g. `src/plan-session-state.ts`:
   - store cursor via `appendEntry`
   - store active full plan snapshot separately from `appendEntry`
   - load both deterministically on resume
2. Add evidence extraction module, e.g. `src/resume-evidence.ts`:
   - consider only `customType === "subagent-slash-result"`
   - ignore placeholders
   - use only final `subagent-slash-result` messages whose content includes `## Subagent result`
   - extract only the `## Subagent result` section as the evidence blob
   - map executed command index to final result in chronological order
   - include completed-prefix outputs plus the failed-command output
   - truncate each evidence blob to ~8000 chars
3. Add public resume workflow, e.g. `src/resume-plan.ts`:
   - trigger from `/plan-orchestrator resume`
   - load cursor and active plan snapshot
   - collect evidence
   - generate valid remainder JSON
   - merge with `mergePlanRemainder(...)`
   - continue execution from the cursor
4. Preserve failed-step metadata and completed command prefix semantics via the existing merge contract.

### Files expected to change
- `src/plan-session-state.ts` (new)
- `src/resume-evidence.ts` (new)
- `src/resume-plan.ts` (new)
- `test/plan-session-state.test.ts` (new)
- `test/resume-evidence.test.ts` (new)
- `test/resume-plan.test.ts` (new)

### Tests to add first (RED → GREEN)
1. `savePlanSessionState writes only the cursor to appendEntry and stores the active plan snapshot separately`
2. `collectResumeEvidence ignores placeholders and returns completed-prefix evidence plus failed-command evidence`
3. `resumePlan merges the adapted remainder and resumes from the failed cursor`

### Tests to complete before phase exit
- `loadPlanSessionState reloads the same active plan snapshot for resume`
- `collectResumeEvidence ignores entries without customType subagent-slash-result`
- `collectResumeEvidence ignores slash-result entries without ## Subagent result`
- `collectResumeEvidence extracts only the ## Subagent result section from qualifying final messages`
- `collectResumeEvidence preserves chronological mapping from executed command index to final evidence entry (n-th executed command ↔ n-th final qualifying subagent-slash-result)`
- `collectResumeEvidence truncates evidence blobs to ~8000 chars`
- `resumePlan does not open the editor`
- `resumePlan preserves failed-step metadata after merge`
- `resumePlan preserves completed prefix command strings after merge`
- `resumePlan allows later steps to be fully rewritten`
- `resumePlan stops and preserves cursor when remainder generation exhausts retries`

### Gate to enter Phase 5
**Targeted gate**
```bash
node --experimental-strip-types --test test/plan-session-state.test.ts test/resume-evidence.test.ts test/resume-plan.test.ts test/planner-loop.test.ts test/plan-execution.test.ts test/command-compiler.test.ts test/plan-schemas.test.ts test/remainder-merge.test.ts
```

**Full-suite gate**
```bash
npm test
```

### Exit criteria
- Resume behavior matches the PRD end-to-end at the core-module level
- Cursor-only `appendEntry` behavior is preserved
- Active plan snapshot storage is separate and sufficient for deterministic resume

---

## Phase 5 — UI-first `/plan-orchestrator` and `/plan-orchestrator resume` command surfaces

### Goal
Wire the tested deep modules into a thin extension entrypoint that delivers the required UI behavior.

### Why this phase comes late
The command handler should mostly orchestrate already-tested modules rather than invent core logic.

### Scope
1. Implement `src/index.ts` entrypoint and register:
   - `/plan-orchestrator`
   - `/plan-orchestrator resume`
2. `/plan-orchestrator` must:
   - generate valid plan JSON
   - render the plan and exact stored slash commands in the UI
   - open a multi-line editor for refinement instructions
   - validate refined output before acceptance
   - require one explicit approval before execution
   - not auto-execute before approval
3. `/plan-orchestrator resume` must:
   - trigger immediate resume flow
   - skip the editor
   - surface resume failures clearly without mutating the cursor on retry exhaustion

### Files expected to change
- `src/index.ts` (new)
- `test/index.test.ts` (new)

### Tests to add first (RED → GREEN)
1. `/plan-orchestrator shows the plan before execution and waits for approval`
2. `/plan-orchestrator resume skips the editor and resumes immediately`

### Tests to complete before phase exit
- `/plan-orchestrator shows the exact stored commands in the UI`
- `/plan-orchestrator opens the editor for refinement instructions`
- `/plan-orchestrator validates refined JSON before execution`
- `/plan-orchestrator starts execution only after one approval for the whole run`
- `/plan-orchestrator uses the slash-bridge executor path rather than sendUserMessage() to run stored /chain and /parallel commands`
- `/plan-orchestrator reports the failing stepIndex/commandIndex when a command fails (so resume knows where to continue)`
- `/plan-orchestrator resume surfaces actionable errors without clearing the cursor`

### Gate to enter Phase 6
**Targeted gate**
```bash
node --experimental-strip-types --test test/index.test.ts test/resume-plan.test.ts test/plan-session-state.test.ts test/resume-evidence.test.ts test/planner-loop.test.ts test/plan-execution.test.ts test/command-compiler.test.ts test/plan-schemas.test.ts test/remainder-merge.test.ts
```

**Full-suite gate**
```bash
npm test
```

### Exit criteria
- The real extension command surfaces match the PRD’s user-facing behavior
- `src/index.ts` remains thin and orchestration-focused

---

## Phase 6 — Packaging, repo integration, and release-readiness smoke checks

### Goal
Finish the package so the extension is installable, coherent, and safe to hand to a user for real exercise.

### Why this phase is last
This phase should validate the finished system, not substitute for earlier module-level correctness.

### Scope
1. Confirm `package.json` and Pi manifest are correct for the finished entrypoint.
2. Confirm dependency vs peerDependency choices match Pi packaging guidance.
3. Add one thin smoke test path that covers command registration and happy-path orchestration through public boundaries.
4. Tighten docs only as needed to reflect the implementation that now exists.

### Files expected to change
- `package.json`
- `src/index.ts` (only if packaging integration requires small adjustments)
- `test/index.test.ts` (may gain one smoke-path assertion)
- docs in `.phased-implementation/`, PRD, or TDD docs only if they need synchronization after implementation reality

### Tests to add or finalize before phase exit
- `package manifest points at the extension entrypoint`
- `extension registers /plan-orchestrator and /plan-orchestrator resume`
- One smoke-path test proving the happy path is wired through the public interface and slash-bridge execution path without depending on private helpers

### Final release gate
**Targeted gate**
```bash
node --experimental-strip-types --test test/**/*.test.ts
```

**Full-suite gate**
```bash
npm test
```

### Exit criteria
- The package is installable as a Pi extension
- Public command surfaces are registered correctly
- The repo has one coherent, fully green implementation story from plan creation through resume

---

## Cross-phase dependency map

- **Phase 0** must finish before any later work
- **Phase 1** depends on Phase 0
- **Phase 2** depends on Phase 1
- **Phase 3** depends on Phase 0
- **Phase 4** depends on Phases 0, 1, 2, and 3
- **Phase 5** depends on Phases 0 through 4
- **Phase 6** depends on Phases 0 through 5

---

## Recommended implementation order inside each phase

For each phase:

1. Pick the first listed RED test
2. Make that one test pass with the smallest change
3. Add the next failing behavior test
4. Repeat until the phase’s targeted gate is green
5. Run `npm test`
6. Only then start the next phase

---

## Definition of done for this plan

This phased plan is complete when the repo reaches a point where:

- strict JSON planning works
- stored commands compile into structured slash-bridge params
- sequential execution is correct and foreground-only
- failures produce correct cursor state
- resume uses completed-prefix + failed-command evidence
- remainder adaptation preserves the merge contract exactly
- `/plan-orchestrator` is UI-first with one approval
- `/plan-orchestrator resume` auto-adapts immediately
- all gates remain green phase by phase
