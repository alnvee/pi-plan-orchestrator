/**
 * DO NOT move protocol-critical enforcement logic into config.
 *
 * Excluded categories:
 * - Protocol identifiers and persistence/sentinel semantics (schema version, cursor sentinel values, PLAN_SESSION_* identifiers)
 * - Slash-bridge interop contract (event names, request/response envelope semantics, resume-evidence customType/markdown markers)
 * - Command grammar/validation contract (e.g., /chain vs /parallel parsing, --bg rejection, stored-command allowlists)
 * - Planner message routing contract (e.g., customType "plan-orchestrator-planner" and triggerTurn/deliverAs wiring)
 *
 * Note: default prompt templates include canonical strict prompt lines for visibility/editing, but the prompt builders
 * will auto-inject those canonical lines if your template omits them.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

export type PlanOrchestratorConfig = {
	llm: {
		strictJsonRepairPrompt: string;
		defaultStrictJsonRepairRetries: number;
	};
	slashBridge: {
		defaultTimeoutMs: number;
	};
	resumeEvidence: {
		maxEvidenceChars: number;
	};
	ui: {
		widgetKey: string;
		widgetPlacement: "aboveEditor";
		widgetHeading: string;
		goalLabelPrefix: string;
		descriptionIndent: string;
		commandIndent: string;
		usageHelpMessage: string;
		interactiveUiRequiredMessage: string;
		editorTitle: string;
		editorPrefill: string;
		confirmTitle: string;
		confirmMessage: string;
		planCompletedNotification: string;
		resumeCompletedNotification: string;
		simplePlanMaxSteps: number;
		simplePlanMaxCommands: number;
		alwaysShowRefinement: boolean;
	};
	initialPlan: {
		personaLine: string;
		userRequestLabel: string;
		/**
		 * Editable full prompt template blocks.
		 *
		 * The {{placeholders}} are substituted by the prompt builders.
		 */
		promptTemplateBlocks: string[];
	};
	refinedPlan: {
		introLine: string;
		currentRequestLabel: string;
		currentPlanJsonLabel: string;
		refinementInstructionsLabel: string;
		/** Editable full prompt template blocks for the refined planner. */
		promptTemplateBlocks: string[];
	};
	resumePlan: {
		cursorLabelPrefix: string;
		originalPlanJsonLabel: string;
		completedPrefixEvidenceLabel: string;
		failedCommandEvidenceLabel: string;
		/** Editable full prompt template blocks for the remainder re-plan prompt. */
		promptTemplateBlocks: string[];
	};
};

/**
 * Defaults (also used as the base for config-file overrides).
 *
 * NOTE: This constant is intentionally deterministic and does not read from disk.
 */
export const PLAN_ORCHESTRATOR_CONFIG: PlanOrchestratorConfig = {
	llm: {
		strictJsonRepairPrompt: "Fix to strict JSON schema",
		defaultStrictJsonRepairRetries: 2,
	},
	slashBridge: {
		defaultTimeoutMs: 15000,
	},
	resumeEvidence: {
		maxEvidenceChars: 8000,
	},
	ui: {
		widgetKey: "plan-orchestrator",
		widgetPlacement: "aboveEditor",
		widgetHeading: "Plan orchestrator",
		goalLabelPrefix: "Goal: ",
		descriptionIndent: "   ",
		commandIndent: "   ",
		usageHelpMessage:
			"Usage: /plan-orchestrator <request> | /plan-orchestrator resume",
		interactiveUiRequiredMessage:
			"/plan-orchestrator requires an interactive UI to refine and confirm execution.",
		editorTitle: "Refine plan",
		editorPrefill: "",
		confirmTitle: "Start execution?",
		confirmMessage: "Execute the approved plan as a single foreground run?",
		planCompletedNotification: "Plan completed",
		resumeCompletedNotification: "Resume completed",
		simplePlanMaxSteps: 1,
		simplePlanMaxCommands: 2,
		alwaysShowRefinement: false,
	},
	initialPlan: {
		personaLine: "You are the dedicated planner for /plan-orchestrator.",
		userRequestLabel: "User request:",
		promptTemplateBlocks: [
			"{{personaLine}}",
			"Return strict JSON only.",
			"Use schemaVersion 1 and include only goal and steps.",
			"Each step must have title, optional description, and commands.",
			"Every command must start with /chain or /parallel.",
			"Reject --bg; allow --fork.",
			"Output must be valid JSON only (no Markdown code fences, no extra text).",
			"Slash-bridge stored command rules: for /chain, the first agent step must include a task; for /parallel, at least one agent step must include a task (or provide a shared task after ' -- ').",
			"Tasks must be quoted in /chain and /parallel commands so the stored-command parser can extract them.",
			"Do not inspect or read the codebase while planning (no read/grep/find/bash tools). Only output strict JSON and the required /chain and /parallel stored-command strings.",
			"pi-subagents built-in agent names (use these in /chain and /parallel): scout, planner, researcher, reviewer, oracle, worker, delegate, context-builder.",
			"Preferred per-plan-step multi-agent pattern: /chain scout '...' -> reviewer '...' -> oracle '...' -> worker '...' (use /parallel only when independent branches truly can run concurrently).",
			"Stored-command grammar (write exactly this syntax inside commands[]):\n- /chain (per-step arrow tasks): /chain agent1 'task1' -> agent2 'task2' -> ... [--fork]\n- /parallel (per-step arrow tasks): /parallel agent1 'task1' -> agent2 'task2' -> ... [--fork]\n- Agent token: agentName[inlineConfig] where inlineConfig is comma-separated (progress, output=false, outputMode=inline|file-only, reads=a+b, model=..., skill=a+b).",
			"If you use --fork, put it at the very end of the command.",
			"{{userRequestLabel}}",
			"{{request}}",
		],
	},
	refinedPlan: {
		introLine:
			"Revise the current plan using the user's refinement instructions.",
		currentRequestLabel: "Current request:",
		currentPlanJsonLabel: "Current plan JSON:",
		refinementInstructionsLabel: "Refinement instructions:",
		promptTemplateBlocks: [
			"{{introLine}}",
			"Return strict JSON only.",
			"Use schemaVersion 1 and include only goal and steps.",
			"Each step must have title, optional description, and commands.",
			"Every command must start with /chain or /parallel.",
			"Reject --bg; allow --fork.",
			"Output must be valid JSON only (no Markdown code fences, no extra text).",
			"Slash-bridge stored command rules: for /chain, the first agent step must include a task; for /parallel, at least one agent step must include a task (or provide a shared task after ' -- ').",
			"Tasks must be quoted in /chain and /parallel commands so the stored-command parser can extract them.",
			"Do not inspect or read the codebase while planning (no read/grep/find/bash tools). Only output strict JSON and the required /chain and /parallel stored-command strings.",
			"pi-subagents built-in agent names (use these in /chain and /parallel): scout, planner, researcher, reviewer, oracle, worker, delegate, context-builder.",
			"Preferred per-plan-step multi-agent pattern: /chain scout '...' -> reviewer '...' -> oracle '...' -> worker '...' (use /parallel only when independent branches truly can run concurrently).",
			"Stored-command grammar (write exactly this syntax inside commands[]):\n- /chain (per-step arrow tasks): /chain agent1 'task1' -> agent2 'task2' -> ... [--fork]\n- /parallel (per-step arrow tasks): /parallel agent1 'task1' -> agent2 'task2' -> ... [--fork]\n- Agent token: agentName[inlineConfig] where inlineConfig is comma-separated (progress, output=false, outputMode=inline|file-only, reads=a+b, model=..., skill=a+b).",
			"If you use --fork, put it at the very end of the command.",
			"When refining, preserve existing valid /chain and /parallel command strings from the currentPlanJson unless the refinementInstructions explicitly require changes.",
			"{{currentRequestLabel}}",
			"{{request}}",
			"{{currentPlanJsonLabel}}",
			"{{currentPlanJson}}",
			"{{refinementInstructionsLabel}}",
			"{{refinementInstructions}}",
		],
	},
	resumePlan: {
		cursorLabelPrefix: "Cursor:",
		originalPlanJsonLabel: "Original plan JSON:",
		completedPrefixEvidenceLabel: "Completed prefix evidence:",
		failedCommandEvidenceLabel: "Failed command evidence:",
		promptTemplateBlocks: [
			"Adapt the remainder of this plan only. Return strict JSON matching the remainder schema.",
			"Output must be valid JSON only (no Markdown code fences, no extra text).",
			"Preserve the remaining step count exactly: remainder.steps.length must equal originalPlanJson.steps.length - cursor.stepIndex.",
			"Remainder.steps[0] (the failed step) must provide replacement commands starting at cursor.commandIndex only (do not repeat commands[0..cursor.commandIndex-1]).",
			"Stored command rules: every command starts with /chain or /parallel; /chain requires a task on its first agent step; /parallel requires at least one task; tasks must be quoted; never include --bg.",
			"Do not inspect or read the codebase while replanning the remainder (no read/grep/find/bash tools). Only output strict JSON and the required /chain and /parallel stored-command strings.",
			"pi-subagents built-in agent names (use these in /chain and /parallel): scout, planner, researcher, reviewer, oracle, worker, delegate, context-builder.",
			"Stored-command grammar (write exactly this syntax inside commands[]):\n- /chain (per-step arrow tasks): /chain agent1 'task1' -> agent2 'task2' -> ... [--fork]\n- /parallel (per-step arrow tasks): /parallel agent1 'task1' -> agent2 'task2' -> ... [--fork]\n- Agent token: agentName[inlineConfig] where inlineConfig is comma-separated (progress, output=false, outputMode=inline|file-only, reads=a+b, model=..., skill=a+b).",
			"If you use --fork, put it at the very end of the command.",
			"{{cursorLine}}",
			"{{originalPlanJsonLabel}}",
			"{{originalPlanJson}}",
			"{{completedPrefixEvidenceLabel}}",
			"{{completedPrefixEvidenceItems}}",
			"{{failedCommandEvidenceLabel}}",
			"{{failedCommandEvidenceItem}}",
			"Return only JSON.",
		],
	},
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeOverridesIntoBase(base: unknown, overrides: unknown): unknown {
	if (!isPlainObject(base) || !isPlainObject(overrides)) return base;

	const result: Record<string, unknown> = { ...base };
	for (const [key, overrideValue] of Object.entries(overrides)) {
		if (!(key in base)) continue;

		const baseValue = (base as Record<string, unknown>)[key];

		if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
			result[key] = mergeOverridesIntoBase(baseValue, overrideValue);
			continue;
		}

		if (typeof baseValue === "string" && typeof overrideValue === "string") {
			result[key] = overrideValue;
			continue;
		}

		if (typeof baseValue === "number" && typeof overrideValue === "number") {
			// Avoid NaN/Infinity poisoning.
			if (Number.isFinite(overrideValue)) result[key] = overrideValue;
			continue;
		}

		if (typeof baseValue === "boolean" && typeof overrideValue === "boolean") {
			result[key] = overrideValue;
			continue;
		}

		if (Array.isArray(baseValue) && Array.isArray(overrideValue)) {
			result[key] = overrideValue;
		}
	}

	return result;
}

function tryReadYamlFile(filePath: string): unknown | undefined {
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = parseYaml(raw);
		return parsed;
	} catch {
		return undefined;
	}
}

function loadOverridesFromConfigPath(configPath: string): unknown | undefined {
	try {
		const stat = fs.statSync(configPath);
		if (stat.isFile()) {
			return tryReadYamlFile(configPath);
		}
		if (stat.isDirectory()) {
			const candidates = ["config.yaml", "config.yml"];
			for (const candidate of candidates) {
				const fullPath = path.join(configPath, candidate);
				if (!fs.existsSync(fullPath)) continue;
				return tryReadYamlFile(fullPath);
			}
		}
	} catch {
		// Missing path is expected.
	}

	return undefined;
}

export function loadPlanOrchestratorConfigFromDisk(args?: {
	homeConfigPath?: string;
	localConfigPath?: string;
}): PlanOrchestratorConfig {
	const homePath =
		args?.homeConfigPath ??
		path.join(os.homedir(), ".pi", "pi-plan-orchestrator");
	const localPath =
		args?.localConfigPath ??
		path.join(process.cwd(), ".pi", "pi-plan-orchestrator");

	const homeOverrides = loadOverridesFromConfigPath(homePath);
	const localOverrides = loadOverridesFromConfigPath(localPath);

	let merged: PlanOrchestratorConfig = PLAN_ORCHESTRATOR_CONFIG;
	if (homeOverrides !== undefined) {
		merged = mergeOverridesIntoBase(
			merged,
			homeOverrides,
		) as PlanOrchestratorConfig;
	}
	if (localOverrides !== undefined) {
		merged = mergeOverridesIntoBase(
			merged,
			localOverrides,
		) as PlanOrchestratorConfig;
	}

	return merged;
}

let cachedConfig: PlanOrchestratorConfig | undefined;
let didLoadConfig = false;

/**
 * Loads YAML overrides from:
 * - ~/.pi/pi-plan-orchestrator (lower precedence)
 * - ./.pi/pi-plan-orchestrator (higher precedence)
 *
 * If neither path exists, returns PLAN_ORCHESTRATOR_CONFIG defaults.
 */
export function getPlanOrchestratorConfig(): PlanOrchestratorConfig {
	if (didLoadConfig) return cachedConfig ?? PLAN_ORCHESTRATOR_CONFIG;
	didLoadConfig = true;

	try {
		cachedConfig = loadPlanOrchestratorConfigFromDisk();
	} catch {
		cachedConfig = PLAN_ORCHESTRATOR_CONFIG;
	}

	return cachedConfig;
}
