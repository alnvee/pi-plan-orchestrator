import {
	validatePlanJson,
	validateRemainderJson,
	type ExecutionCursor,
	type Plan,
	type PlanRemainder,
} from "./plan-schemas.ts";

import {
	PLAN_ORCHESTRATOR_CONFIG,
	getPlanOrchestratorConfig,
} from "./plan-orchestrator-config.ts";

export const STRICT_JSON_REPAIR_PROMPT =
	PLAN_ORCHESTRATOR_CONFIG.llm.strictJsonRepairPrompt;
export const DEFAULT_STRICT_JSON_REPAIR_RETRIES =
	PLAN_ORCHESTRATOR_CONFIG.llm.defaultStrictJsonRepairRetries;

interface StrictJsonLoopInput<TValue> {
	prompt: string;
	generate: (prompt: string) => Promise<string>;
	validate: (
		value: unknown,
	) => { ok: true; value: TValue } | { ok: false; errors: string[] };
	maxRetries?: number;
	cursor?: ExecutionCursor;
}

export interface GenerateValidPlanJsonInput {
	prompt: string;
	generate: (prompt: string) => Promise<string>;
	maxRetries?: number;
}

export interface GenerateValidRemainderJsonInput {
	prompt: string;
	generate: (prompt: string) => Promise<string>;
	cursor: ExecutionCursor;
	maxRetries?: number;
}

export interface StrictJsonLoopSuccess<TValue> {
	ok: true;
	value: TValue;
	attempts: number;
	prompts: string[];
	cursor?: ExecutionCursor;
}

export interface StrictJsonLoopFailure {
	ok: false;
	errors: string[];
	attempts: number;
	prompts: string[];
	cursor?: ExecutionCursor;
}

export type StrictJsonLoopResult<TValue> =
	| StrictJsonLoopSuccess<TValue>
	| StrictJsonLoopFailure;

function parseStrictJson(
	raw: string,
): { ok: true; value: unknown } | { ok: false; errors: string[] } {
	try {
		return { ok: true, value: JSON.parse(raw) };
	} catch (error) {
		return {
			ok: false,
			errors: [
				`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
			],
		};
	}
}

function toPromptWithRepair(basePrompt: string): string {
	const config = getPlanOrchestratorConfig();
	return `${basePrompt}\n\n${config.llm.strictJsonRepairPrompt}`;
}

async function runStrictJsonLoop<TValue>(
	input: StrictJsonLoopInput<TValue>,
): Promise<StrictJsonLoopResult<TValue>> {
	const maxRetries =
		input.maxRetries ??
		getPlanOrchestratorConfig().llm.defaultStrictJsonRepairRetries;
	const maxAttempts = maxRetries + 1;
	const prompts: string[] = [];
	const repairPrompt = toPromptWithRepair(input.prompt);
	let lastErrors: string[] = [];

	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		const currentPrompt = attempt === 0 ? input.prompt : repairPrompt;
		prompts.push(currentPrompt);
		const raw = await input.generate(currentPrompt);
		const parsed = parseStrictJson(raw);
		if (parsed.ok) {
			const validated = input.validate(parsed.value);
			if (validated.ok) {
				return {
					ok: true,
					value: validated.value,
					attempts: attempt + 1,
					prompts,
					...(input.cursor ? { cursor: input.cursor } : {}),
				};
			}
			lastErrors = validated.errors;
		} else {
			lastErrors = parsed.errors;
		}
	}

	return {
		ok: false,
		errors: [
			`Strict JSON validation failed after ${maxAttempts} attempts`,
			...lastErrors,
		],
		attempts: maxAttempts,
		prompts,
		...(input.cursor ? { cursor: input.cursor } : {}),
	};
}

function validatePlanValue(
	value: unknown,
): { ok: true; value: Plan } | { ok: false; errors: string[] } {
	const result = validatePlanJson(value);
	return result.ok
		? { ok: true, value: result.plan }
		: { ok: false, errors: result.errors };
}

function validateRemainderValue(
	value: unknown,
): { ok: true; value: PlanRemainder } | { ok: false; errors: string[] } {
	const result = validateRemainderJson(value);
	return result.ok
		? { ok: true, value: result.remainder }
		: { ok: false, errors: result.errors };
}

export function generateValidPlanJson(
	input: GenerateValidPlanJsonInput,
): Promise<StrictJsonLoopResult<Plan>> {
	return runStrictJsonLoop<Plan>({
		prompt: input.prompt,
		generate: input.generate,
		validate: validatePlanValue,
		maxRetries: input.maxRetries,
	});
}

export function generateValidRemainderJson(
	input: GenerateValidRemainderJsonInput,
): Promise<StrictJsonLoopResult<PlanRemainder>> {
	return runStrictJsonLoop<PlanRemainder>({
		prompt: input.prompt,
		generate: input.generate,
		validate: validateRemainderValue,
		maxRetries: input.maxRetries,
		cursor: input.cursor,
	});
}
