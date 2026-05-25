import assert from "node:assert/strict";
import { test } from "node:test";

import { PLAN_ORCHESTRATOR_CONFIG } from "../src/plan-orchestrator-config.ts";
import {
	buildInitialPlanPrompt,
	buildRefinedPlanPrompt,
} from "../src/plan-orchestrator-extension.ts";
import { buildResumeRemainderPrompt } from "../src/resume-plan.ts";
import type { Plan, ExecutionCursor } from "../src/plan-schemas.ts";

test("PLAN_ORCHESTRATOR_CONFIG defaults are stable", () => {
	assert.equal(
		PLAN_ORCHESTRATOR_CONFIG.llm.strictJsonRepairPrompt,
		"Fix to strict JSON schema",
	);
	assert.equal(PLAN_ORCHESTRATOR_CONFIG.llm.defaultStrictJsonRepairRetries, 2);
	assert.equal(PLAN_ORCHESTRATOR_CONFIG.slashBridge.defaultTimeoutMs, 15000);
	assert.equal(PLAN_ORCHESTRATOR_CONFIG.resumeEvidence.maxEvidenceChars, 8000);

	assert.equal(PLAN_ORCHESTRATOR_CONFIG.ui.widgetKey, "plan-orchestrator");
	assert.equal(PLAN_ORCHESTRATOR_CONFIG.ui.widgetPlacement, "aboveEditor");
	assert.equal(PLAN_ORCHESTRATOR_CONFIG.ui.widgetHeading, "Plan orchestrator");
	assert.equal(PLAN_ORCHESTRATOR_CONFIG.ui.goalLabelPrefix, "Goal: ");
	assert.equal(PLAN_ORCHESTRATOR_CONFIG.ui.descriptionIndent, "   ");
	assert.equal(PLAN_ORCHESTRATOR_CONFIG.ui.commandIndent, "   ");

	assert.equal(
		PLAN_ORCHESTRATOR_CONFIG.ui.usageHelpMessage,
		"Usage: /plan-orchestrator <request> | /plan-orchestrator resume",
	);
	assert.equal(
		PLAN_ORCHESTRATOR_CONFIG.ui.interactiveUiRequiredMessage,
		"/plan-orchestrator requires an interactive UI to refine and confirm execution.",
	);
	assert.equal(PLAN_ORCHESTRATOR_CONFIG.ui.editorTitle, "Refine plan");
	assert.equal(PLAN_ORCHESTRATOR_CONFIG.ui.editorPrefill, "");
	assert.equal(PLAN_ORCHESTRATOR_CONFIG.ui.confirmTitle, "Start execution?");
	assert.equal(
		PLAN_ORCHESTRATOR_CONFIG.ui.confirmMessage,
		"Execute the approved plan as a single foreground run?",
	);
	assert.equal(
		PLAN_ORCHESTRATOR_CONFIG.ui.planCompletedNotification,
		"Plan completed",
	);
	assert.equal(
		PLAN_ORCHESTRATOR_CONFIG.ui.resumeCompletedNotification,
		"Resume completed",
	);

	assert.equal(
		PLAN_ORCHESTRATOR_CONFIG.initialPlan.personaLine,
		"You are the dedicated planner for /plan-orchestrator.",
	);
	assert.equal(
		PLAN_ORCHESTRATOR_CONFIG.initialPlan.userRequestLabel,
		"User request:",
	);

	assert.equal(
		PLAN_ORCHESTRATOR_CONFIG.refinedPlan.introLine,
		"Revise the current plan using the user's refinement instructions.",
	);
	assert.equal(
		PLAN_ORCHESTRATOR_CONFIG.refinedPlan.currentRequestLabel,
		"Current request:",
	);
	assert.equal(
		PLAN_ORCHESTRATOR_CONFIG.refinedPlan.currentPlanJsonLabel,
		"Current plan JSON:",
	);
	assert.equal(
		PLAN_ORCHESTRATOR_CONFIG.refinedPlan.refinementInstructionsLabel,
		"Refinement instructions:",
	);

	assert.equal(
		PLAN_ORCHESTRATOR_CONFIG.resumePlan.cursorLabelPrefix,
		"Cursor:",
	);
	assert.equal(
		PLAN_ORCHESTRATOR_CONFIG.resumePlan.originalPlanJsonLabel,
		"Original plan JSON:",
	);
	assert.equal(
		PLAN_ORCHESTRATOR_CONFIG.resumePlan.completedPrefixEvidenceLabel,
		"Completed prefix evidence:",
	);
	assert.equal(
		PLAN_ORCHESTRATOR_CONFIG.resumePlan.failedCommandEvidenceLabel,
		"Failed command evidence:",
	);
});

test("strict protocol prompt strings remain verbatim", () => {
	const initialPrompt = buildInitialPlanPrompt("build a feature");
	assert.ok(initialPrompt.includes("Return strict JSON only."));
	assert.ok(
		initialPrompt.includes(
			"Use schemaVersion 1 and include only goal and steps.",
		),
	);
	assert.ok(
		initialPrompt.includes(
			"Every command must start with /chain or /parallel.",
		),
	);
	assert.ok(initialPrompt.includes("Reject --bg; allow --fork."));

	const plan: Plan = {
		schemaVersion: 1,
		goal: "ship feature",
		steps: [{ title: "Step A", commands: ['/chain scout "scan code"'] }],
	};
	const refinedPrompt = buildRefinedPlanPrompt(
		"build a feature",
		plan,
		"make it better",
	);
	assert.ok(refinedPrompt.includes("Return strict JSON only."));
	assert.ok(
		refinedPrompt.includes(
			"Use schemaVersion 1 and include only goal and steps.",
		),
	);

	const cursor: ExecutionCursor = { stepIndex: 0, commandIndex: 0 };
	const remainderPrompt = buildResumeRemainderPrompt(plan, cursor, {
		cursor,
		entries: [],
		completedPrefix: [],
		failedCommand: undefined,
	} as any);
	assert.ok(
		remainderPrompt.includes(
			"Adapt the remainder of this plan only. Return strict JSON matching the remainder schema.",
		),
	);
	assert.ok(remainderPrompt.includes("Return only JSON."));
});
