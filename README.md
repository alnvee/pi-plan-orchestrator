# pi-plan-orchestrator

`pi-plan-orchestrator` is a Pi extension that turns a goal into a guided, reviewable, resumable execution plan.
It uses `pi-subagents` so each plan step can fan out into multiple agents, then executes the resulting
`/chain` and `/parallel` commands in array order.

## What it does

- Gathers repository context (hidden) using `pi-subagents` before planning (cached per session; refreshed when the request or codebase state changes)
- Generates an initial strict JSON plan for `/plan-orchestrator <request>`
- Shows the plan in the UI with an overview and review checklist before execution
- Lets you refine larger plans with natural-language feedback; simple plans can fast-path to confirmation
- Persists the active plan and execution cursor in the session
- Resumes from saved session state with `/plan-orchestrator resume` (skips context-gathering and shows a resume review summary first)
- Rewrites the remaining commands after failures so execution adapts to work already completed

## Installation

Install from npm with Pi's package manager:

```bash
pi install npm:pi-plan-orchestrator
```

For a local checkout while developing:

```bash
npm install
pi install ./
```

> Use `pi install`, not plain `npm install`, if you want Pi to register the package.

## Usage

Once installed, run:

```text
/plan-orchestrator <your goal or task>
```

The command will:

1. Gather repository context (hidden) using `pi-subagents`
2. Draft an initial strict JSON plan
3. Show the plan in the UI with an overview and review checklist
4. Let you refine it in natural language when the plan is complex enough to need it
5. Ask for confirmation with the final plan summary
6. Execute each step sequentially
7. Persist state so `/plan-orchestrator resume` can continue after a failure and present a resume review summary before rewriting the remainder

Each step can contain an array of `/chain` and `/parallel` commands, so one plan step can coordinate
multiple agents.

## Configuration

You can override non-protocol tunables via YAML (including the *full* prompt templates used for planning and resume).

Pi looks for a config in:
- `~/.pi/pi-plan-orchestrator/config.yaml` (or `config.yml`)
- `./.pi/pi-plan-orchestrator/config.yaml` (or `config.yml`)

If both exist, the local `./.pi/...` config overrides the home `~/.pi/...` config.
(If `~/.pi/pi-plan-orchestrator` or `./.pi/pi-plan-orchestrator` is a *file*, it is treated as YAML directly.)

Only keys present in `src/plan-orchestrator-config.ts` are supported.

Other supported non-protocol tunables:
- `llm.strictJsonRepairPrompt`, `llm.defaultStrictJsonRepairRetries`
- `slashBridge.defaultTimeoutMs`
- `resumeEvidence.maxEvidenceChars`
- `ui.*` (widget/labels/indentation and user-facing messages)

### Prompt template overrides

The YAML config lets you edit the *full prompt text* for each planning phase.

Each prompt is built as:
1) Take the template block array
2) Substitute `{{placeholders}}`
3) Drop blocks that become empty after substitution
4) Join remaining blocks with `"\n\n"`

Prompts you can override:
- `initialPlan.promptTemplateBlocks` — prompt for the initial `/plan-orchestrator <request>` planner turn
- `refinedPlan.promptTemplateBlocks` — prompt for the refinement turn (`ctx.ui.editor(...)`)
- `resumePlan.promptTemplateBlocks` — prompt for `/plan-orchestrator resume` remainder-only rewriting

Supported placeholders:
- Initial planner: `{{personaLine}}`, `{{userRequestLabel}}`, `{{request}}`
- Refined planner: `{{introLine}}`, `{{currentRequestLabel}}`, `{{request}}`, `{{currentPlanJsonLabel}}`, `{{currentPlanJson}}`, `{{refinementInstructionsLabel}}`, `{{refinementInstructions}}`
- Resume remainder prompt: `{{cursorLine}}`, `{{originalPlanJsonLabel}}`, `{{originalPlanJson}}`, `{{completedPrefixEvidenceLabel}}`, `{{completedPrefixEvidenceItems}}`, `{{failedCommandEvidenceItem}}`

Additional internal context injection (hidden):
- Before running the **initial** and optional **refined** planner turns, the extension runs the `scout` subagent (using a cached output when possible) and injects its condensed output into the planner prompt as an internal block (`Internal codebase context for planning ...`).
- The context cache is stored per session (in the session directory) and is refreshed when the request changes or when a best-effort codebase fingerprint indicates the working tree has changed.
- This injected block is not controlled by the YAML template system; it’s added automatically so the planner doesn’t need to re-discover repo details.
- On `/plan-orchestrator resume`, this context step is skipped.

#### Strategy A safety (canonical strict protocol injection)

Even if you edit the templates, the extension will ensure the canonical strict protocol lines are present:

- **Initial prompt** (auto-injected after the first block, in canonical order):
  - `Return strict JSON only.`
  - `Use schemaVersion 1 and include only goal and steps.`
  - `Each step must have title, optional description, and commands.`
  - `Every command must start with /chain or /parallel.`
  - `Reject --bg; allow --fork.`

- **Refined prompt** (ensured in the final prompt):
  - `Return strict JSON only.`
  - `Use schemaVersion 1 and include only goal and steps.`

- **Resume remainder prompt** (ensured in the final prompt):
  - Start: `Adapt the remainder of this plan only. Return strict JSON matching the remainder schema.`
  - End: `Return only JSON.`

Note: In resume templates, evidence placeholders like `{{completedPrefixEvidenceItems}}` / `{{failedCommandEvidenceItem}}` become an empty string when that evidence doesn’t exist; those blocks will be dropped.

Example `config.yaml`:

```yaml
slashBridge:
  defaultTimeoutMs: 30000

# Increase evidence size:
resumeEvidence:
  maxEvidenceChars: 12000

# Override the initial planner prompt template:
initialPlan:
  promptTemplateBlocks:
    - "{{personaLine}}"
    - "Return strict JSON only."
    - "Use schemaVersion 1 and include only goal and steps."
    - "{{userRequestLabel}}"
    - "{{request}}"
```

## Development

```bash
npm test
```

There is no build step; Pi loads the TypeScript entrypoint directly from `src/index.ts`.

## Package manifest

This repo is published as a Pi package via `package.json`:

- `pi.extensions` points at `./src/index.ts`
- `keywords` includes `pi-package` for discoverability
- runtime dependencies live in `dependencies`
- Pi core packages remain `peerDependencies`

## License

MIT
