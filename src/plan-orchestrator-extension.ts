import { randomUUID } from "node:crypto";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import {
	generateValidPlanJson,
	generateValidRemainderJson,
} from "./planner-loop.ts";
import { runPlan, type PlanExecutionDeps } from "./plan-execution.ts";
import {
	loadPlanSessionState,
	savePlanSessionState,
	type PlanSessionManagerLike,
} from "./plan-session-state.ts";
import { resumePlan } from "./resume-plan.ts";
import type { Plan, ExecutionCursor } from "./plan-schemas.ts";
import { getPlanOrchestratorConfig } from "./plan-orchestrator-config.ts";
import type { PlanOrchestratorConfig } from "./plan-orchestrator-config.ts";

export interface PlanOrchestratorPlanner {
	generatePlan(prompt: string): Promise<string>;
	generateRemainder(prompt: string): Promise<string>;
}

export interface PlanOrchestratorDependencies {
	planner?: PlanOrchestratorPlanner;
	plannerFactory?: (
		pi: ExtensionAPI,
		ctx: ExtensionCommandContext,
	) => PlanOrchestratorPlanner | Promise<PlanOrchestratorPlanner>;
	executeCommand: PlanExecutionDeps["executeCommand"];
	maxRetries?: number;
}

export interface PlanOrchestratorRegistration {
	register(pi: ExtensionAPI): void;
}

const PLAN_ORCHESTRATOR_COMMAND = "plan-orchestrator";
const NO_ACTIVE_CURSOR: ExecutionCursor = { stepIndex: -1, commandIndex: -1 };

const REQUIRED_INITIAL_STRICT_LINES = [
	"Return strict JSON only.",
	"Use schemaVersion 1 and include only goal and steps.",
	"Each step must have title, optional description, and commands.",
	"Every command must start with /chain or /parallel.",
	"Reject --bg; allow --fork.",
];

const REQUIRED_REFINED_STRICT_LINES = [
	"Return strict JSON only.",
	"Use schemaVersion 1 and include only goal and steps.",
];

function renderPromptTemplateBlocks(
	templateBlocks: string[],
	placeholders: Record<string, string>,
): string[] {
	const rendered: string[] = [];
	for (const rawBlock of templateBlocks) {
		const block = typeof rawBlock === "string" ? rawBlock : String(rawBlock);
		let next = block;
		for (const [key, value] of Object.entries(placeholders)) {
			next = next.split(`{{${key}}}`).join(value);
		}
		if (next.trim().length === 0) continue;
		rendered.push(next);
	}
	return rendered;
}

function ensureCanonicalStrictLines(
	blocks: string[],
	requiredLines: string[],
): string[] {
	const prompt = blocks.join("\n\n");
	let insertAt = blocks.length > 0 ? 1 : 0;
	for (const line of requiredLines) {
		if (prompt.includes(line)) continue;
		blocks.splice(insertAt, 0, line);
		insertAt += 1;
	}
	return blocks;
}

export function buildInitialPlanPromptWithConfig(
	request: string,
	config: PlanOrchestratorConfig,
): string {
	const blocks = renderPromptTemplateBlocks(
		config.initialPlan.promptTemplateBlocks,
		{
			personaLine: config.initialPlan.personaLine,
			userRequestLabel: config.initialPlan.userRequestLabel,
			request,
		},
	);

	ensureCanonicalStrictLines(blocks, REQUIRED_INITIAL_STRICT_LINES);
	return blocks.join("\n\n");
}

export function buildRefinedPlanPromptWithConfig(
	request: string,
	plan: Plan,
	refinementInstructions: string,
	config: PlanOrchestratorConfig,
): string {
	const blocks = renderPromptTemplateBlocks(
		config.refinedPlan.promptTemplateBlocks,
		{
			introLine: config.refinedPlan.introLine,
			currentRequestLabel: config.refinedPlan.currentRequestLabel,
			request,
			currentPlanJsonLabel: config.refinedPlan.currentPlanJsonLabel,
			currentPlanJson: JSON.stringify(plan, null, 2),
			refinementInstructionsLabel:
				config.refinedPlan.refinementInstructionsLabel,
			refinementInstructions,
		},
	);

	ensureCanonicalStrictLines(blocks, REQUIRED_REFINED_STRICT_LINES);
	return blocks.join("\n\n");
}

function buildInitialPlanPrompt(request: string): string {
	return buildInitialPlanPromptWithConfig(request, getPlanOrchestratorConfig());
}

function buildRefinedPlanPrompt(
	request: string,
	plan: Plan,
	refinementInstructions: string,
): string {
	return buildRefinedPlanPromptWithConfig(
		request,
		plan,
		refinementInstructions,
		getPlanOrchestratorConfig(),
	);
}

function renderPlanWidget(plan: Plan): string[] {
	const ui = getPlanOrchestratorConfig().ui;
	const lines: string[] = [
		ui.widgetHeading,
		`${ui.goalLabelPrefix}${plan.goal}`,
		"",
	];
	plan.steps.forEach((step, index) => {
		lines.push(`${index + 1}. ${step.title}`);
		if (step.description)
			lines.push(`${ui.descriptionIndent}${step.description}`);
		for (const command of step.commands) {
			lines.push(`${ui.commandIndent}${command}`);
		}
		lines.push("");
	});
	return lines;
}

function createPlanSessionManagerAdapter(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): PlanSessionManagerLike {
	return {
		getSessionDir: () => ctx.sessionManager.getSessionDir(),
		appendCustomEntry: (customType: string, data?: unknown) => {
			pi.appendEntry(customType, data);
			return randomUUID();
		},
		getEntries: () =>
			ctx.sessionManager.getEntries() as unknown as Array<{
				type: string;
				customType?: string;
				data?: unknown;
			}>,
	};
}

async function resolvePlanner(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	deps: PlanOrchestratorDependencies,
): Promise<PlanOrchestratorPlanner> {
	if (deps.planner) return deps.planner;
	if (deps.plannerFactory) return await deps.plannerFactory(pi, ctx);
	throw new Error("Plan orchestrator planner dependency is not configured");
}

async function generateAndRenderPlan(
	ctx: ExtensionCommandContext,
	planner: PlanOrchestratorPlanner,
	deps: PlanOrchestratorDependencies,
	prompt: string,
): Promise<{ ok: true; plan: Plan } | { ok: false; errors: string[] }> {
	const result = await generateValidPlanJson({
		prompt,
		generate: planner.generatePlan,
		maxRetries: deps.maxRetries,
	});
	if (!result.ok) return result;
	if (ctx.hasUI) {
		const config = getPlanOrchestratorConfig();
		ctx.ui.setWidget(config.ui.widgetKey, renderPlanWidget(result.value), {
			placement: config.ui.widgetPlacement,
		});
	}
	return { ok: true, plan: result.value };
}

async function runPlanOrchestrator(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string,
	deps: PlanOrchestratorDependencies,
): Promise<void> {
	const request = args.trim();
	const config = getPlanOrchestratorConfig();
	if (!request) {
		ctx.ui.notify(config.ui.usageHelpMessage, "error");
		return;
	}

	if (!ctx.hasUI) {
		ctx.ui.notify(config.ui.interactiveUiRequiredMessage, "error");
		return;
	}

	const planner = await resolvePlanner(pi, ctx, deps);
	const initial = await generateAndRenderPlan(
		ctx,
		planner,
		deps,
		buildInitialPlanPrompt(request),
	);
	if (!initial.ok) {
		ctx.ui.notify(initial.errors.join("\n"), "error");
		return;
	}

	let plan = initial.plan;
	const refinementInstructions = await ctx.ui.editor(
		config.ui.editorTitle,
		config.ui.editorPrefill,
	);
	if (
		typeof refinementInstructions === "string" &&
		refinementInstructions.trim().length > 0
	) {
		const refined = await generateAndRenderPlan(
			ctx,
			planner,
			deps,
			buildRefinedPlanPrompt(request, plan, refinementInstructions.trim()),
		);
		if (!refined.ok) {
			ctx.ui.notify(refined.errors.join("\n"), "error");
			return;
		}
		plan = refined.plan;
	}

	const confirmed = await ctx.ui.confirm(
		config.ui.confirmTitle,
		config.ui.confirmMessage,
	);
	if (!confirmed) return;

	const session = createPlanSessionManagerAdapter(pi, ctx);
	savePlanSessionState({
		sessionManager: session,
		plan,
		cursor: NO_ACTIVE_CURSOR,
	});

	const execution = await runPlan(plan, NO_ACTIVE_CURSOR, {
		executeCommand: deps.executeCommand,
	});

	savePlanSessionState({
		sessionManager: session,
		plan,
		cursor: execution.cursor,
	});

	if (!execution.ok) {
		ctx.ui.notify(
			`Execution failed at step ${execution.cursor.stepIndex}, command ${execution.cursor.commandIndex}: ${execution.failed.error}`,
			"error",
		);
		return;
	}

	ctx.ui.notify(config.ui.planCompletedNotification, "info");
}

async function runPlanOrchestratorResume(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	deps: PlanOrchestratorDependencies,
): Promise<void> {
	const config = getPlanOrchestratorConfig();
	const planner = await resolvePlanner(pi, ctx, deps);
	const session = createPlanSessionManagerAdapter(pi, ctx);
	const loaded = loadPlanSessionState({ sessionManager: session });
	const result = await resumePlan({
		loadPlanSessionState: () => loaded,
		getEntries: () => session.getEntries(),
		generateValidRemainderJson,
		generateRemainder: planner.generateRemainder,
		executeCommand: deps.executeCommand,
		maxRetries: deps.maxRetries,
	});

	if (!result.ok) {
		ctx.ui.notify(result.errors.join("\n"), "error");
		return;
	}

	savePlanSessionState({
		sessionManager: session,
		plan: result.mergedPlan,
		cursor: result.execution.cursor,
	});

	if (!result.execution.ok) {
		ctx.ui.notify(
			`Resume failed at step ${result.execution.cursor.stepIndex}, command ${result.execution.cursor.commandIndex}: ${result.execution.failed.error}`,
			"error",
		);
		return;
	}

	ctx.ui.notify(config.ui.resumeCompletedNotification, "info");
}

export function registerPlanOrchestratorExtension(
	pi: ExtensionAPI,
	deps: PlanOrchestratorDependencies,
): void {
	pi.registerCommand(PLAN_ORCHESTRATOR_COMMAND, {
		description:
			"Generate or resume a strict JSON plan with /chain and /parallel commands",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed === "resume") {
				await runPlanOrchestratorResume(pi, ctx, deps);
				return;
			}
			await runPlanOrchestrator(pi, ctx, trimmed, deps);
		},
	});
}

export { buildInitialPlanPrompt, buildRefinedPlanPrompt, renderPlanWidget };
