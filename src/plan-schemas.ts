import { Type } from "typebox";
import Schema from "typebox/schema";

import { isStoredCommandString } from "./stored-command.ts";

export const PLAN_SCHEMA_VERSION = 1;

export const PlanStepSchema = Type.Object(
	{
		title: Type.String({ minLength: 1 }),
		description: Type.Optional(Type.String()),
		commands: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export const PlanSchema = Type.Object(
	{
		schemaVersion: Type.Literal(PLAN_SCHEMA_VERSION),
		goal: Type.String({ minLength: 1 }),
		steps: Type.Array(PlanStepSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export const PlanRemainderSchema = Type.Object(
	{
		schemaVersion: Type.Literal(PLAN_SCHEMA_VERSION),
		steps: Type.Array(PlanStepSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export const ExecutionCursorSchema = Type.Object(
	{
		// -1 means no active cursor
		stepIndex: Type.Integer({ minimum: -1 }),
		commandIndex: Type.Integer({ minimum: -1 }),
	},
	{ additionalProperties: false },
);

export type PlanStep = {
	title: string;
	description?: string;
	commands: string[];
};

export type Plan = {
	schemaVersion: typeof PLAN_SCHEMA_VERSION;
	goal: string;
	steps: PlanStep[];
};

export type PlanRemainder = {
	schemaVersion: typeof PLAN_SCHEMA_VERSION;
	steps: PlanStep[];
};

export type ExecutionCursor = {
	stepIndex: number;
	commandIndex: number;
};

type ValidatorLike = {
	Check(value: unknown): boolean;
	Errors(value: unknown): Iterable<{ path: string; message: string }>;
};

const planValidator = Schema.Compile(PlanSchema) as ValidatorLike;
const remainderValidator = Schema.Compile(PlanRemainderSchema) as ValidatorLike;
const cursorValidator = Schema.Compile(ExecutionCursorSchema) as ValidatorLike;

function formatErrors(validator: ValidatorLike, value: unknown): string[] {
	const errors: string[] = [];
	const visit = (entry: unknown): void => {
		if (
			entry === false ||
			entry === true ||
			entry === null ||
			entry === undefined
		)
			return;
		if (Array.isArray(entry)) {
			for (const item of entry) visit(item);
			return;
		}
		if (typeof entry !== "object") {
			errors.push(String(entry));
			return;
		}

		const error = entry as {
			instancePath?: unknown;
			path?: unknown;
			schemaPath?: unknown;
			message?: unknown;
			keyword?: unknown;
		};
		const path =
			typeof error.instancePath === "string" && error.instancePath.length > 0
				? error.instancePath
				: typeof error.path === "string" && error.path.length > 0
					? error.path
					: typeof error.schemaPath === "string" && error.schemaPath.length > 0
						? error.schemaPath
						: "/";
		const message =
			typeof error.message === "string" && error.message.length > 0
				? error.message
				: typeof error.keyword === "string" && error.keyword.length > 0
					? error.keyword
					: "invalid value";
		errors.push(`${path}: ${message}`);
	};

	for (const entry of validator.Errors(value) as Iterable<unknown>) {
		visit(entry);
	}

	return errors;
}

function validateStoredCommandPrefixes(steps: PlanStep[]): string[] {
	const errors: string[] = [];

	steps.forEach((step, stepIndex) => {
		step.commands.forEach((command, commandIndex) => {
			if (!isStoredCommandString(command)) {
				errors.push(
					`/steps/${stepIndex}/commands/${commandIndex}: command must start with /chain or /parallel`,
				);
			}
		});
	});

	return errors;
}

function validateCursorSentinel(cursor: ExecutionCursor): string[] {
	if (cursor.stepIndex === -1 && cursor.commandIndex === -1) return [];
	if (cursor.stepIndex === -1 || cursor.commandIndex === -1) {
		return [
			"/cursor: stepIndex and commandIndex must both be -1 or both be non-negative",
		];
	}
	return [];
}

export function validatePlanJson(
	value: unknown,
): { ok: true; plan: Plan } | { ok: false; errors: string[] } {
	if (!planValidator.Check(value)) {
		return { ok: false, errors: formatErrors(planValidator, value) };
	}

	const plan = value as Plan;
	const commandErrors = validateStoredCommandPrefixes(plan.steps);
	if (commandErrors.length > 0) return { ok: false, errors: commandErrors };

	return { ok: true, plan };
}

export function validateRemainderJson(
	value: unknown,
): { ok: true; remainder: PlanRemainder } | { ok: false; errors: string[] } {
	if (!remainderValidator.Check(value)) {
		return { ok: false, errors: formatErrors(remainderValidator, value) };
	}

	const remainder = value as PlanRemainder;
	const commandErrors = validateStoredCommandPrefixes(remainder.steps);
	if (commandErrors.length > 0) return { ok: false, errors: commandErrors };

	return { ok: true, remainder };
}

export function validateCursorJson(
	value: unknown,
): { ok: true; cursor: ExecutionCursor } | { ok: false; errors: string[] } {
	if (!cursorValidator.Check(value)) {
		return { ok: false, errors: formatErrors(cursorValidator, value) };
	}

	const cursor = value as ExecutionCursor;
	const sentinelErrors = validateCursorSentinel(cursor);
	if (sentinelErrors.length > 0) return { ok: false, errors: sentinelErrors };

	return { ok: true, cursor };
}
