import assert from "node:assert/strict";
import { test } from "node:test";

import { PLAN_ORCHESTRATOR_CONFIG } from "../src/plan-orchestrator-config.ts";
import {
	buildInitialPlanPromptWithConfig,
	buildRefinedPlanPromptWithConfig,
} from "../src/plan-orchestrator-extension.ts";
import { buildResumeRemainderPromptWithConfig } from "../src/resume-plan.ts";
import type { Plan } from "../src/plan-schemas.ts";
import type { ExecutionCursor } from "../src/plan-schemas.ts";
import type { ResumeEvidenceBundle } from "../src/resume-evidence.ts";

function cloneConfig(): typeof PLAN_ORCHESTRATOR_CONFIG {
	return JSON.parse(JSON.stringify(PLAN_ORCHESTRATOR_CONFIG));
}

function makePlan(): Plan {
	return {
		schemaVersion: 1,
		goal: "ship feature",
		steps: [
			{
				title: "Step A",
				commands: [' /chain scout "scan code"'.trim()],
			},
		],
	};
}

test("initial prompt injects canonical strict JSON lines when template omits them", () => {
	const config = cloneConfig();
	config.initialPlan.promptTemplateBlocks = [
		"{{personaLine}}",
		"{{userRequestLabel}}",
		"{{request}}",
	];

	const prompt = buildInitialPlanPromptWithConfig("build a feature", config);

	assert.ok(prompt.includes("Return strict JSON only."));
	assert.ok(
		prompt.includes("Use schemaVersion 1 and include only goal and steps."),
	);
	assert.ok(
		prompt.includes(
			"Each step must have title, optional description, and commands.",
		),
	);
	assert.ok(
		prompt.includes("Every command must start with /chain or /parallel."),
	);
	assert.ok(prompt.includes("Reject --bg; allow --fork."));
	assert.ok(prompt.includes("User request:"));
});

test("refined prompt injects canonical strict JSON lines when template omits them", () => {
	const config = cloneConfig();
	config.refinedPlan.promptTemplateBlocks = [
		"{{introLine}}",
		"{{currentRequestLabel}}",
		"{{request}}",
		"{{refinementInstructions}}",
	];

	const plan = makePlan();
	const prompt = buildRefinedPlanPromptWithConfig(
		"build a feature",
		plan,
		"make it better",
		config,
	);

	assert.ok(prompt.includes("Return strict JSON only."));
	assert.ok(
		prompt.includes("Use schemaVersion 1 and include only goal and steps."),
	);
});

test("resume remainder prompt injects canonical strict start/end when template omits them", () => {
	const config = cloneConfig();
	config.resumePlan.promptTemplateBlocks = [
		"{{cursorLine}}",
		"{{originalPlanJsonLabel}}",
		"{{originalPlanJson}}",
	];

	const plan = makePlan();
	const cursor: ExecutionCursor = { stepIndex: 0, commandIndex: 0 };
	const evidence: ResumeEvidenceBundle = {
		cursor,
		entries: [],
		completedPrefix: [],
		failedCommand: undefined,
	};

	const prompt = buildResumeRemainderPromptWithConfig(
		plan,
		cursor,
		evidence,
		config,
	);

	assert.ok(
		prompt.includes(
			"Adapt the remainder of this plan only. Return strict JSON matching the remainder schema.",
		),
	);
	assert.ok(prompt.includes("Return only JSON."));
});
