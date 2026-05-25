# Code Context

## Files Retrieved
1. `src/plan-schemas.ts` (lines 6-144) - Defines the plan/remainder JSON schema, `PLAN_SCHEMA_VERSION = 1`, and cursor sentinel rules.
2. `src/plan-orchestrator-extension.ts` (lines 40-281) - Main entrypoint: slash command registration, hard-coded planner prompts, UI widget labels/strings, and session save/resume wiring.
3. `src/planner-loop.ts` (lines 9-111) - Strict-JSON retry loop: `STRICT_JSON_REPAIR_PROMPT`, `DEFAULT_STRICT_JSON_REPAIR_RETRIES`.
4. `src/slash-bridge-executor.ts` (lines 11-230) - Slash bridge protocol/event names and the default `timeoutMs`.
5. `src/plan-session-state.ts` (lines 11-139) - Persistence identifiers: `PLAN_SESSION_CURSOR_CUSTOM_TYPE` + snapshot filename.
6. `src/resume-evidence.ts` (lines 22-98) - Evidence extraction protocol (`subagent-slash-result`, `## Subagent result`) and hard-coded truncation limit `8000`.
7. `src/index.ts` (lines 68-76) - Planner message wiring (`customType: "plan-orchestrator-planner"`, `{ triggerTurn: true, deliverAs: "nextTurn" }`).
8. `src/command-compiler.ts` (lines 1-264) - Stored command language parsing: `/chain`, `/parallel`, `--fork`, `--bg`, inline config keys/values.
9. `src/stored-command.ts` (lines 1-29) - `/chain` vs `/parallel` token detection and whitespace boundary rules.
10. `src/resume-plan.ts` (lines 58-91) - Remainder re-planning prompt construction (strict JSON + schema instructions).

## Key Code

### User-editable config candidates (behavior/UI tuning)

- **Strict JSON repair defaults** (tunable reliability/cost)
  - `STRICT_JSON_REPAIR_PROMPT = "Fix to strict JSON schema"` (`src/planner-loop.ts:9`).
  - `DEFAULT_STRICT_JSON_REPAIR_RETRIES = 2` (`src/planner-loop.ts:10`), used when `input.maxRetries` is not provided (`src/planner-loop.ts:77`).

- **Slash bridge execution timeout**
  - `timeoutMs = options.timeoutMs ?? 15_000` (`src/slash-bridge-executor.ts:167`).

- **Resume evidence max length**
  - `return content.length > 8000 ? content.slice(0, 8000) : content;` (`src/resume-evidence.ts:57`).

- **UI widget placement + labels (UX / localization)**
  - Widget key: `ctx.ui.setWidget("plan-orchestrator", ...)` (`src/plan-orchestrator-extension.ts:129`).
    - *Practical caution:* this key is asserted in `test/index.test.ts`, so changing it will require test updates.
  - Widget placement: `{ placement: "aboveEditor" }` (`src/plan-orchestrator-extension.ts:130`).
  - Widget heading/formatting:
    - Heading: `"Plan orchestrator"` (`src/plan-orchestrator-extension.ts:75`).
    - Goal label: `` `Goal: ${plan.goal}` `` (`src/plan-orchestrator-extension.ts:75`).
    - Step numbering: `` `${index + 1}. ${step.title}` `` (`src/plan-orchestrator-extension.ts:77`).
    - Optional step description indentation: `` `   ${step.description}` `` (`src/plan-orchestrator-extension.ts:78`).
    - Command indentation: `` `   ${command}` `` (`src/plan-orchestrator-extension.ts:80`).

- **UI notifications (user-facing strings)**
  - Usage/help message: `"Usage: /plan-orchestrator <request> | /plan-orchestrator resume"` (`src/plan-orchestrator-extension.ts:145`).
  - UI requirement message: `"/plan-orchestrator requires an interactive UI to refine and confirm execution."` (`src/plan-orchestrator-extension.ts:153`).
  - Completion notifications:
    - `"Plan completed"` (`src/plan-orchestrator-extension.ts:221`).
    - `"Resume completed"` (`src/plan-orchestrator-extension.ts:260`).

- **UI editor/confirm wording**
  - Editor title/prefill: `ctx.ui.editor("Refine plan", "")` (`src/plan-orchestrator-extension.ts:172`).
  - Confirm title/message:
    - `"Start execution?"` (`src/plan-orchestrator-extension.ts:191`).
    - `"Execute the approved plan as a single foreground run?"` (`src/plan-orchestrator-extension.ts:192`).

- **Prompt “wording” outside strict protocol constraints**
  - The code hard-codes several instruction blocks in:
    - `buildInitialPlanPrompt` (`src/plan-orchestrator-extension.ts:43-51`).
    - `buildRefinedPlanPrompt` (`src/plan-orchestrator-extension.ts:56-69`).
    - `buildResumeRemainderPrompt` (`src/resume-plan.ts:58-91`).

  Some of these strings are *protocol-enforcing* (see next section), but even then, you might still make the “persona/wording/section headers” configurable as long as the strict constraints remain compatible.

### Protocol / compatibility-critical values (likely must remain stable)

- **Plan/remainder JSON schema + versioning**
  - `PLAN_SCHEMA_VERSION = 1` (`src/plan-schemas.ts:6`).
  - Schema shape constraints are hard-coded (protocol-level validation):
    - `minLength: 1`, `minItems: 1`, `additionalProperties: false` for plan step/plan objects (`src/plan-schemas.ts:10-31`).
    - Cursor sentinel rules: `stepIndex`/`commandIndex` minimum `-1` (`src/plan-schemas.ts:37-40`) and validation that `-1,-1` means “no active cursor” (`src/plan-schemas.ts:141-144`).

- **Cursor sentinel semantics** (must match across schema + execution + persistence)
  - `NO_ACTIVE_CURSOR` = `{ stepIndex: -1, commandIndex: -1 }` (`src/plan-orchestrator-extension.ts:41`).
  - `resolveStartCursor` maps `-1,-1` to execution start at `{0,0}` (`src/plan-execution.ts:62-63`).
  - `runPlan` returns `{ stepIndex: -1, commandIndex: -1 }` on completion (`src/plan-execution.ts:157`).

- **Slash-bridge event bus contract**
  - Event names used for interop:
    - `subagent:slash:request` / `subagent:slash:started` / `subagent:slash:response` / `subagent:slash:update` (`src/slash-bridge-executor.ts:11-14`).

- **Slash-bridge command language / parsing contract**
  - `/chain` vs `/parallel` tokens + strict token-boundary rules (`src/stored-command.ts:5-21`, `src/stored-command.ts:28-29`).
  - `--fork` parsing (`src/command-compiler.ts:113-118`) and hard rejection of `--bg` (`src/command-compiler.ts:224-225`).
  - Command must start with `/chain` or `/parallel` (`src/command-compiler.ts:232`).
  - Required compiled param defaults that other components likely expect:
    - `clarify: false`, `agentScope: "both"` in chain/parallel params (`src/command-compiler.ts:248-249`, `src/command-compiler.ts:260-261`).
  - Inline config “mini-language” keys/values (protocol surface):
    - Allowed `outputMode` values: `"inline" | "file-only"` (`src/command-compiler.ts:10-14`).
    - Inline keys handled by the parser: `output`, `outputMode`, `reads`, `model`, `skill(s)`, `progress` (`src/command-compiler.ts:65-82`).

- **Slash subagent result / resume-evidence protocol**
  - CustomType used to recognize slash outputs for resume: `entry.customType === "subagent-slash-result"` (`src/resume-evidence.ts:63`).
  - Extraction expects a markdown heading line exactly equal to `## Subagent result` (`src/resume-evidence.ts:41`) and then stops at the next markdown `## ...` heading (`src/resume-evidence.ts:47`).

- **Session persistence identifiers** (resume relies on these exact strings)
  - Cursor customType: `PLAN_SESSION_CURSOR_CUSTOM_TYPE = "plan-orchestrator-cursor"` (`src/plan-session-state.ts:11`).
  - Snapshot filename: `PLAN_SESSION_SNAPSHOT_FILENAME = "plan-orchestrator.active-plan.json"` (`src/plan-session-state.ts:12-13`).

- **Planner message routing contract**
  - `customType: "plan-orchestrator-planner"` (`src/index.ts:71`).
  - Message routing options:
    - `display: false` (`src/index.ts:73`).
    - `details: { source: "plan-orchestrator" }` (`src/index.ts:74`).
    - `{ triggerTurn: true, deliverAs: "nextTurn" }` (`src/index.ts:76`).

- **Slash command contract + widget key (interop with UI/tests)**
  - Slash command registered as `PLAN_ORCHESTRATOR_COMMAND = "plan-orchestrator"` (`src/plan-orchestrator-extension.ts:40`).
  - Widget key used for rendering: `ctx.ui.setWidget("plan-orchestrator", ...)` (`src/plan-orchestrator-extension.ts:129`).

- **Protocol-enforcing parts inside prompts** (must stay aligned with the schema + command grammar)
  - Initial plan prompt includes hard requirements for strict schema + grammar:
    - `"Return strict JSON only."` (`src/plan-orchestrator-extension.ts:46`).
    - `"Use schemaVersion 1 and include only goal and steps."` (`src/plan-orchestrator-extension.ts:47`).
    - `"Every command must start with /chain or /parallel."` (`src/plan-orchestrator-extension.ts:49`).
    - `"Reject --bg; allow --fork."` (`src/plan-orchestrator-extension.ts:50`).
  - Refined plan prompt repeats the same protocol constraints (`src/plan-orchestrator-extension.ts:63-64`).
  - Remainder prompt requires strict remainder-schema JSON:
    - `"Adapt the remainder of this plan only. Return strict JSON matching the remainder schema."` (`src/resume-plan.ts:65`).
    - Ends with `"Return only JSON."` (`src/resume-plan.ts:91`).

  ⚠️ Risk: `schemaVersion` is hard-coded as the literal `1` in prompt strings (`src/plan-orchestrator-extension.ts:47` and `:64`) *in addition to* `PLAN_SCHEMA_VERSION = 1` in `src/plan-schemas.ts:6`. If you ever change schemaVersion, these must be updated in lockstep.

### Test assertions that effectively “lock” protocol strings

- `test/planner-loop.test.ts` matches `STRICT_JSON_REPAIR_PROMPT` in repair attempts (e.g. around `src/planner-loop.ts`-derived prompt expectations) (`test/planner-loop.test.ts:46`, `:67`, `:94`, etc.).
- `test/resume-evidence.test.ts` asserts resume evidence truncation to exactly `8000` (`test/resume-evidence.test.ts:72`, `:84`) and uses `customType: "subagent-slash-result"` (`test/resume-evidence.test.ts:12`).
- `test/default-export.test.ts` asserts planner wiring: `customType: "plan-orchestrator-planner"` and `{ triggerTurn: true, deliverAs: "nextTurn" }` (`test/default-export.test.ts:271-274`, `:388-391`).
- `test/index.test.ts` asserts widget key/content includes `"plan-orchestrator"` and the widget header/goal lines (`test/index.test.ts:177-178`, `:248-249`).

## Architecture

High-level dataflow (where the hard-coded values show up):

1. **Command parsing / command-language contract**
   - `src/stored-command.ts` + `src/command-compiler.ts` parse stored step commands (`/chain` / `/parallel`, inline config, `--fork`, reject `--bg`).

2. **Plan JSON protocol**
   - `src/plan-schemas.ts` defines the strict JSON schemas for `Plan`, `PlanRemainder`, and `ExecutionCursor`.

3. **LLM strict JSON generation + repair loop**
   - `src/planner-loop.ts` runs `runStrictJsonLoop`, using:
     - `STRICT_JSON_REPAIR_PROMPT` + `DEFAULT_STRICT_JSON_REPAIR_RETRIES` when initial output fails parsing/validation.

4. **UI + slash command orchestration**
   - `src/plan-orchestrator-extension.ts` registers the slash command (`PLAN_ORCHESTRATOR_COMMAND`), builds the initial/refined planner prompts, renders the plan widget, asks for confirmation, and persists session state.

5. **Execution via slash-bridge events**
   - `src/slash-bridge-executor.ts` compiles stored commands into params and emits/receives events using `subagent:slash:*` names, with a default `timeoutMs`.

6. **Resume / remainder re-planning**
   - `src/plan-session-state.ts` loads the saved snapshot + cursor.
   - `src/resume-evidence.ts` collects evidence by filtering entries with `customType: "subagent-slash-result"` and extracting the `## Subagent result` section; it truncates at `8000` chars.
   - `src/resume-plan.ts` builds the remainder prompt (strict remainder-schema JSON) and uses the strict JSON repair loop.

## Start Here

Open `src/plan-schemas.ts` first: it’s the protocol “source of truth” for `PLAN_SCHEMA_VERSION`, required schema shape, and cursor sentinel semantics—these determine which prompt/serialization/customType values must remain stable for compatibility.
