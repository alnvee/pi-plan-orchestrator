## Problem Statement

Pi users need a reliable way to turn a natural-language request into a **multi-step, multi-agent execution plan** that:

- Produces a **strict, machine-readable JSON plan**.
- Restricts execution to a safe/known surface area: only **pi-subagents** `/chain` and `/parallel` slash commands.
- Shows the user the **exact commands** that will run so they can correct mistakes before anything executes.
- Executes those commands **sequentially** and **stops on the first failure**.
- Supports **session-persistent resume** after failure, using **adaptive remainder-only command rewriting** so the user does not have to re-plan from scratch.

Additionally, the extension must execute `/chain` and `/parallel` from inside the extension despite a limitation where `sendUserMessage()` does not trigger slash handlers (slash command handling only happens when prompt templates are expanded).

## Solution

Build an npm-installable Pi extension that registers a **`/plan-orchestrator`** command. The extension implements three phases:

1. **Planning (UI-first, no auto-execution initially)**
   - Generate a strict JSON plan using a TypeBox-validated schema.
   - The plan contains `steps[]`, where each step has:
     - `title: string`
     - optional `description?: string`
     - `commands: string[]` where every command is a **slash command string** restricted to `/chain ...` or `/parallel ...`.
   - Show the plan and the **exact `/chain` / `/parallel` commands** in the UI for correction.
   - Open a multi-line editor (`ctx.ui.editor`) for user refinement instructions.
   - If the planner/refiner returns invalid JSON / wrong schema, automatically re-prompt with **“Fix to strict JSON schema”** (up to 2 retries) until the JSON validates.
   - Only after a single explicit user confirmation for the whole run, transition to execution.

2. **Execution (foreground-only, sequential, stop on failure)**
   - Execute each `commands[]` entry **sequentially in array order**.
   - **Disallow** any stored/executed command string containing `--bg` (foreground-only constraint). Allow `--fork`.
   - Stop immediately on the first failing command and record a **resume cursor**.
   - Execution uses pi-subagents **slash-bridge event bus** integration (not `sendUserMessage()`), so `/chain` and `/parallel` can run from inside the extension.

3. **Resume & adaptive remainder-only rewriting**
   - Persist only a resume cursor via `pi.appendEntry(...)` with custom type data containing:
     - `stepIndex` (failed/uncompleted step index, or -1 if none)
     - `commandIndex` (failed/uncompleted command index within that step, or -1 if none)
   - On resume after failure:
     - **Auto-adapt immediately** (no editor prompt).
     - Extract evidence from session entries containing the final **`subagent-slash-result`** output (the content includes the **“## Subagent result”** section).
     - Ignore initial placeholder slash-result messages and use only final slash-result messages.
     - Map the *n-th executed plan command* to the *n-th final slash-result message* in chronological order.
     - Use evidence for commands in the completed prefix region; truncate each extracted evidence blob to ~8000 chars.
     - Ask the LLM for a **remainder-only** plan JSON starting at the failed cursor.
     - Merge the remainder into the original plan using **remainder-only merge rules**:
       - preserve exact completed `commands[]` string values for the completed prefix
       - preserve failed-step `title` / `description` values exactly
       - for failed step `S`, replace only `commands[C..]`
       - steps after `S` may be fully rewritten
     - If the remainder JSON still fails validation after retry exhaustion, stop resume, surface an actionable UI error, leave the cursor unchanged, and require user intervention.
   - Continue execution sequentially from the updated plan.

## User Stories

1. As a Pi user, I want a single `/plan-orchestrator` command to turn my request into a multi-step execution plan, so I can delegate work to multiple agents.
2. As a Pi user, I want the plan to be **strict JSON**, so I can trust the structure and re-use it.
3. As a Pi user, I want each plan step to have a human-readable `title`, so I can understand what each step accomplishes.
4. As a Pi user, I want each plan step to have an optional `description`, so I can capture extra context when needed.
5. As a Pi user, I want each step to contain `commands[]`, so I can see exactly what will be executed.
6. As a Pi user, I want every command in `commands[]` to be restricted to **only** `/chain ...` or `/parallel ...`, so the extension’s behavior is predictable.
7. As a Pi user, I want the extension to show the **exact** `/chain` / `/parallel` commands that will run, so I can confirm or correct agent routing.
8. As a Pi user, I want to see the full plan in the UI before execution begins, so nothing runs unexpectedly.
9. As a Pi user, I want to open a multi-line editor (`ctx.ui.editor`) to provide refinement instructions, so I can fix planning mistakes in natural language.
10. As a Pi user, if my refinement request causes the planner/refiner to output invalid JSON, I want the extension to automatically ask the model to **“Fix to strict JSON schema”** and retry (up to 2 times), so I don’t have to manually intervene.
11. As a Pi user, I want the extension to validate the refined JSON against the strict schema before accepting it, so execution is always based on a known-good structure.
12. As a Pi user, I want a clear single “start execution” confirmation after the plan is accepted, so I remain in control without being re-prompted before every command.
13. As a Pi user, I want execution to run **sequentially** through `commands[]` in the exact order provided, so the workflow respects dependencies.
14. As a Pi user, I want the extension to stop on the first failing command, so I don’t waste time executing a broken plan.
15. As a Pi user, I want the extension to notify me which command failed (and at which step/command index), so I understand what went wrong.
16. As a Pi user, I want the extension to enforce a **foreground-only** constraint by rejecting stored/executed command strings that include `--bg`, so I never unintentionally kick off background work.
17. As a Pi user, I want to allow `--fork` for safe isolation when needed, so I can manage state without risking corruption of the current session.
18. As a Pi user, after a failure, I want the extension to persist only the resume cursor (`stepIndex`, `commandIndex`), so the resume state is minimal but accurate.
19. As a Pi user, when I run `/plan-orchestrator resume`, I want the extension to **auto-adapt immediately** without opening the editor, so I can continue quickly.
20. As a Pi user, I want resume adaptation to use evidence extracted from prior completed command outputs and the failed command output, so the model can correct mistakes using what it already learned.
21. As a Pi user, I want evidence extraction to focus on final `subagent-slash-result` output containing “## Subagent result”, so the model sees the completed outputs rather than placeholders.
22. As a Pi user, I want each evidence blob truncated to ~8000 chars, so the prompt remains manageable.
23. As a Pi user, I want remainder-only rewriting to preserve completed prefixes **byte-for-byte**, so already-correct commands are not altered.
24. As a Pi user, I want the extension to preserve the failed-step `title` and `description` exactly, so step identity and UI continuity remain stable.
25. As a Pi user, I want the extension to replace only the failed step’s `commands[C..]`, so adaptation is scoped and predictable.
26. As a Pi user, I want steps after the failed step to be allowed to fully change, so the model can correct deeper plan structure without being constrained by earlier attempts.
27. As a Pi user, when the remainder is generated, I want it validated against the remainder-only strict JSON schema before merging, so merging never uses malformed data.
28. As a Pi user, if remainder JSON is invalid, I want automatic “Fix to strict JSON schema” retries, so resume is robust.
29. As a Pi user, I want the extension to continue executing from the merged plan starting at the cursor, so resume is seamless.
30. As a Pi user, I want the extension to use pi-subagents execution via the slash-bridge event bus (not `sendUserMessage()`), so `/chain` and `/parallel` reliably execute from inside the extension.

## Implementation Decisions

1. **Command allowlist and parsing/validation**
   - The plan generator must emit only command strings that start with `/chain` or `/parallel`.
   - The execution validator must reject any command string containing `--bg`.
   - The execution validator must allow `--fork` and pass it through to execution parameters.
   - The implementation must include a **command-string compiler** that turns each stored slash command string into structured pi-subagents execution params before emitting the slash-bridge request event.
   - V1 should support the full pi-subagents `/chain` and `/parallel` slash grammar that is relevant to stored plan commands, while still enforcing the orchestrator-specific `--bg` prohibition.

2. **Strict JSON schemas using TypeBox**
   - Use TypeBox schemas to validate:
     - the full plan JSON
     - the remainder-only plan JSON
     - the resume cursor JSON
   - Set schema options to forbid additional properties so schema mismatches are caught early.
   - Validate `commands[]` strings so only `/chain` and `/parallel` commands are allowed.

3. **UI-first planning wizard**
   - After `/plan-orchestrator` is invoked, generate a plan JSON and validate it.
   - Render the plan and the exact `/chain` and `/parallel` command strings in UI for correction.
   - Provide a multi-line editor for user refinement instructions.
   - Ensure execution does not start until after a single explicit user confirmation for the full run.

4. **Planner/refiner retry behavior**
   - If the LLM output fails schema validation (invalid JSON or wrong schema), re-prompt with: **“Fix to strict JSON schema”**.
   - Limit retries to 2 retries per planning or remainder generation attempt.
   - If validation still fails after retry exhaustion, stop the current planning/resume operation, surface an actionable UI error, preserve the current cursor state, and require user intervention before continuing.

5. **Execution engine**
   - Execute `commands[]` sequentially (array order) in the foreground.
   - A command is considered failed if the slash-bridge returns a bridge-level error or if the final slash result contains any subresult with a non-zero `exitCode`.
   - For `/parallel`, any child task failure causes the overall stored command to fail.
   - Stop immediately on the first failing command.
   - Maintain accurate cursor updates so resume points to the first uncompleted (failed) command.

6. **Slash execution inside the extension (pi-subagents slash-bridge event bus)**
   - Do not use `sendUserMessage()` to trigger `/chain` and `/parallel` handlers.
   - Instead, integrate with pi-subagents’ slash bridge event bus by:
     - compiling the stored command string into structured execution params
     - emitting the slash request event with a unique requestId
     - awaiting the corresponding slash response event
     - optionally subscribing to update events for UI status

7. **Session persistence model**
   - Persist only the resume cursor using `pi.appendEntry(...)` (customType dedicated to cursor).
   - “Cursor-only persistence” applies to the appendEntry progress payload: no additional progress metadata should be stored there beyond the cursor.
   - Persist the active full plan snapshot separately from appendEntry in a session-scoped artifact file (or equivalent session-backed file owned by the extension) so prefixes can be reconstructed deterministically on resume without violating the cursor-only appendEntry rule.
   - On successful completion, clear the cursor (set to “no active cursor” state) and mark execution complete.

8. **Evidence extraction for adaptive remainder**
   - During/after execution, extract evidence from session entries with customType `subagent-slash-result`.
   - Ignore initial placeholders and use only final slash-result messages whose content includes **“## Subagent result”**.
   - Map the *n-th executed stored command* to the *n-th final slash-result message* in chronological order.
   - Provide evidence for commands that are strictly in the completed prefix before the cursor, plus the failed command’s final slash-result output.
   - Truncate each evidence blob to ~8000 chars before sending it to the LLM.

9. **Remainder-only merge logic**
   - Merge using remainder-only rules:
     - preserve exact completed `commands[]` string contents for the completed prefix
     - preserve failed-step `title` / `description` values exactly
     - replace only failed-step `commands[C..]`
     - allow full rewrite for steps after the failed step
   - “Byte-for-byte” here means preserving exact command-string values and exact failed-step metadata values, not preserving JSON whitespace or serialization bytes.
   - Implement merge as a pure, unit-testable module.

10. **Resume behavior**
   - Resume is triggered through `/plan-orchestrator resume`.
   - On user resume request:
     - if cursor indicates work remains, immediately generate a remainder-only plan
     - validate remainder-only JSON, merge, update the active plan snapshot
     - continue sequential execution from the cursor

## Testing Decisions

Good tests focus on **external behavior** and **contracts**:

- JSON schema validation:
  - Plan JSON must fail validation on additional fields, wrong types, wrong schemaVersion, and invalid command strings.
  - Remainder JSON must validate only under the remainder schema.
- Remainder-only merge rules:
  - Completed prefixes preserve exact `commands[]` string values.
  - Failed-step metadata is preserved exactly.
  - Only `commands[C..]` changes for the failed step.
  - Steps after the failed step can be fully replaced.
- Execution loop correctness:
  - Sequential ordering is respected.
  - Stop-on-first-failure occurs.
  - Cursor updates point to the correct failed/uncompleted command.
- Resume correctness:
  - Resume triggers remainder-only adaptation automatically (no editor prompt).
  - Evidence extraction uses final `subagent-slash-result` content containing “## Subagent result”.
  - The merged plan is validated before execution continues.

Modules to test (unit + light integration):

1. **Remainder merge module** (pure function, heavy unit test coverage).
2. **Plan/remainder schema validation** using TypeBox validators.
3. **Command validation rules** (allowlist + `--bg` rejection + `--fork` acceptance).
4. **Evidence extraction parser** (final “## Subagent result” section extraction + truncation).

Prior art in the repo:
- A pure remainder merge module and unit tests are already established as the deep module foundation for the remainder-only merge contract.

## Out of Scope

- Executing arbitrary slash commands beyond `/chain` and `/parallel`.
- Background execution support (`--bg`) and anything that relies on background job completion semantics.
- General multi-plan orchestration, scheduling, or DAG execution beyond pi-subagents’ existing `/parallel` semantics.
- UI/UX styling beyond functional correctness (the focus is on correctness of plan/command contracts and resume behavior).
- Full persistence of every intermediate plan snapshot (we only persist cursor via appendEntry; the latest plan snapshot is stored separately for resume reconstruction).

## Further Notes

- **sendUserMessage limitation**: `sendUserMessage()` cannot be used to trigger `/chain`/`/parallel` handlers because slash handling only occurs when prompt templates are expanded and the message starts with `/`.
- Therefore, slash execution from inside the extension is implemented via **pi-subagents slash-bridge event bus** integration.
- **Versioning**: V1 keeps the top-level plan schema minimal: `schemaVersion`, `goal`, and `steps`. It does not require `planId` or `planVersion`.
- **Byte-for-byte prefix preservation**: The remainder-only merge contract is designed to avoid accidental mutation of completed command strings and failed-step metadata values.
- **Packaging**: Declare the extension entrypoint in `package.json` under the `pi.extensions` manifest. Treat pi “core” packages (including TypeBox) as `peerDependencies` where required by Pi packaging guidance.
- **Resolved alignment decisions**:
  - execution requires one approval to start the full run
  - resume is triggered via `/plan-orchestrator resume`
  - cursor-only persistence applies to `appendEntry`; the full plan snapshot may be stored separately
  - V1 supports the full relevant pi-subagents `/chain` and `/parallel` grammar
  - resume evidence includes completed-prefix outputs plus the failed-command output
  - V1 top-level plan schema remains minimal: `schemaVersion`, `goal`, `steps`
  - any child failure inside `/parallel` fails the stored command
  - retry exhaustion stops, surfaces a UI error, and keeps the cursor unchanged
