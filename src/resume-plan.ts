import { mergePlanRemainder } from "./remainder-merge.ts";
import {
	runPlan,
	type PlanExecutionDeps,
	type RunPlanResult,
} from "./plan-execution.ts";
import type { ExecutionCursor, Plan, PlanRemainder } from "./plan-schemas.ts";
import { getPlanOrchestratorConfig } from "./plan-orchestrator-config.ts";
import type { PlanOrchestratorConfig } from "./plan-orchestrator-config.ts";
import {
	collectResumeEvidence,
	type ResumeEvidenceBundle,
	type SessionEntryLike,
} from "./resume-evidence.ts";
import type { LoadPlanSessionStateResult } from "./plan-session-state.ts";
import type { generateValidRemainderJson } from "./planner-loop.ts";

export interface ResumePlanInput {
	loadPlanSessionState: () =>
		| Promise<LoadPlanSessionStateResult>
		| LoadPlanSessionStateResult;
	getEntries: () => SessionEntryLike[];
	generateValidRemainderJson: typeof generateValidRemainderJson;
	generateRemainder: (prompt: string) => Promise<string>;
	executeCommand: PlanExecutionDeps["executeCommand"];
	maxRetries?: number;
	contextSummary?: string;
	onMergedPlanReady?: (mergedPlan: Plan, cursor: ExecutionCursor) => Promise<boolean>;
	onStepStart?: PlanExecutionDeps["onStepStart"];
	onStepComplete?: PlanExecutionDeps["onStepComplete"];
	onCommandStart?: PlanExecutionDeps["onCommandStart"];
	onCommandComplete?: PlanExecutionDeps["onCommandComplete"];
	signal?: AbortSignal;
}

export interface ResumePlanSuccess {
	ok: true;
	cursor: ExecutionCursor;
	originalPlan: Plan;
	evidence: ResumeEvidenceBundle;
	remainder: PlanRemainder;
	mergedPlan: Plan;
	execution: RunPlanResult;
}

export interface ResumePlanFailure {
	ok: false;
	cursor: ExecutionCursor;
	errors: string[];
	originalPlan?: Plan;
	evidence?: ResumeEvidenceBundle;
}

export type ResumePlanResult = ResumePlanSuccess | ResumePlanFailure;

function isNoActiveCursor(cursor: ExecutionCursor): boolean {
	return cursor.stepIndex === -1 && cursor.commandIndex === -1;
}

function describeEvidenceItem(
	prefix: string,
	item: { executionIndex: number; content: string },
): string {
	return `${prefix} ${item.executionIndex + 1}\n${item.content}`;
}

const REQUIRED_RESUME_REMAINDER_STRICT_START =
	"Adapt the remainder of this plan only. Return strict JSON matching the remainder schema.";
const REQUIRED_RESUME_REMAINDER_STRICT_END = "Return only JSON.";

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

function ensureCanonicalResumeStrictLines(blocks: string[]): string[] {
	const prompt = blocks.join("\n\n");
	if (!prompt.includes(REQUIRED_RESUME_REMAINDER_STRICT_START)) {
		blocks.unshift(REQUIRED_RESUME_REMAINDER_STRICT_START);
	}
	if (!prompt.includes(REQUIRED_RESUME_REMAINDER_STRICT_END)) {
		blocks.push(REQUIRED_RESUME_REMAINDER_STRICT_END);
	}
	return blocks;
}

export function buildResumeRemainderPromptWithConfig(
	plan: Plan,
	cursor: ExecutionCursor,
	evidence: ResumeEvidenceBundle,
	config: PlanOrchestratorConfig,
	contextSummary?: string,
): string {
	const cursorLine = `${config.resumePlan.cursorLabelPrefix} stepIndex=${cursor.stepIndex}, commandIndex=${cursor.commandIndex}`;

	const originalPlanJson = JSON.stringify(plan, null, 2);

	const hasCompletedPrefix = evidence.completedPrefix.length > 0;
	const completedPrefixEvidenceLabel = hasCompletedPrefix
		? config.resumePlan.completedPrefixEvidenceLabel
		: "";
	const completedPrefixEvidenceItems = hasCompletedPrefix
		? evidence.completedPrefix
				.map((item) =>
					describeEvidenceItem(`Command ${item.executionIndex + 1}:`, item),
				)
				.join("\n\n")
		: "";

	const failedCommandEvidenceLabel = evidence.failedCommand
		? config.resumePlan.failedCommandEvidenceLabel
		: "";
	const failedCommandEvidenceItem = evidence.failedCommand
		? describeEvidenceItem(
				`Command ${evidence.failedCommand.executionIndex + 1}:`,
				evidence.failedCommand,
			)
		: "";

	const blocks = renderPromptTemplateBlocks(
		config.resumePlan.promptTemplateBlocks,
		{
			cursorLine,
			originalPlanJsonLabel: config.resumePlan.originalPlanJsonLabel,
			originalPlanJson,
			completedPrefixEvidenceLabel,
			completedPrefixEvidenceItems,
			failedCommandEvidenceLabel,
			failedCommandEvidenceItem,
		},
	);

	ensureCanonicalResumeStrictLines(blocks);

	const trimmedContext = contextSummary?.trim();
	if (trimmedContext) {
		const insertAt = blocks.length > 0 ? 1 : 0;
		blocks.splice(
			insertAt,
			0,
			`Current codebase context (use for replanning; do not output verbatim):\n${trimmedContext}`,
		);
	}

	return blocks.join("\n\n");
}

function buildResumeRemainderPrompt(
	plan: Plan,
	cursor: ExecutionCursor,
	evidence: ResumeEvidenceBundle,
	contextSummary?: string,
): string {
	return buildResumeRemainderPromptWithConfig(
		plan,
		cursor,
		evidence,
		getPlanOrchestratorConfig(),
		contextSummary,
	);
}

function normalizeLoadFailure(
	result: Extract<LoadPlanSessionStateResult, { ok: false }>,
): ResumePlanFailure {
	return {
		ok: false,
		cursor: { stepIndex: -1, commandIndex: -1 },
		errors: result.errors,
	};
}

export async function resumePlan(
	input: ResumePlanInput,
): Promise<ResumePlanResult> {
	const loaded = await Promise.resolve(input.loadPlanSessionState());
	if (!loaded.ok) return normalizeLoadFailure(loaded);
	if (isNoActiveCursor(loaded.cursor)) {
		return {
			ok: false,
			cursor: loaded.cursor,
			errors: ["No active cursor"],
			originalPlan: loaded.plan,
		};
	}

	const evidence = collectResumeEvidence(input.getEntries(), loaded.cursor);
	const prompt = buildResumeRemainderPrompt(
		loaded.plan,
		loaded.cursor,
		evidence,
		input.contextSummary,
	);
	const remainderResult = await input.generateValidRemainderJson({
		prompt,
		generate: input.generateRemainder,
		cursor: loaded.cursor,
		maxRetries: input.maxRetries,
	});

	if (!remainderResult.ok) {
		return {
			ok: false,
			cursor: loaded.cursor,
			errors: remainderResult.errors,
			originalPlan: loaded.plan,
			evidence,
		};
	}

	const mergedPlan = mergePlanRemainder(
		loaded.plan,
		loaded.cursor,
		remainderResult.value,
	) as Plan;

	if (input.onMergedPlanReady) {
		const approved = await input.onMergedPlanReady(mergedPlan, loaded.cursor);
		if (!approved) {
			return {
				ok: false,
				cursor: loaded.cursor,
				errors: ["Resume aborted by user"],
				originalPlan: loaded.plan,
				evidence,
			};
		}
	}

	const execution = await runPlan(mergedPlan, loaded.cursor, {
		executeCommand: input.executeCommand,
		onStepStart: input.onStepStart,
		onStepComplete: input.onStepComplete,
		onCommandStart: input.onCommandStart,
		onCommandComplete: input.onCommandComplete,
		signal: input.signal,
	});

	return {
		ok: true,
		cursor: execution.cursor,
		originalPlan: loaded.plan,
		evidence,
		remainder: remainderResult.value,
		mergedPlan,
		execution,
	};
}

export { buildResumeRemainderPrompt };
