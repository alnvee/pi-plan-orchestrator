import {
	validateCursorJson,
	type ExecutionCursor,
	type Plan,
} from "./plan-schemas.ts";

export interface CommandExecutionContext {
	stepIndex: number;
	commandIndex: number;
}

export interface CommandExecutionSuccess {
	ok: true;
	command: string;
	stepIndex: number;
	commandIndex: number;
	exitCode: 0;
	requestId?: string;
}

export interface CommandExecutionFailure {
	ok: false;
	command: string;
	stepIndex: number;
	commandIndex: number;
	exitCode: number;
	error: string;
	requestId?: string;
}

export type CommandExecutionResult =
	| CommandExecutionSuccess
	| CommandExecutionFailure;

export interface PlanExecutionDeps {
	executeCommand: (
		command: string,
		context: CommandExecutionContext,
	) => Promise<CommandExecutionResult>;
	onCommandStart?: (ctx: CommandExecutionContext, command: string) => void;
	onCommandComplete?: (result: CommandExecutionResult) => void;
	skipStepIndices?: Set<number>;
}

export interface RunPlanSuccess {
	ok: true;
	cursor: ExecutionCursor;
	executed: CommandExecutionResult[];
}

export interface RunPlanFailure {
	ok: false;
	cursor: ExecutionCursor;
	failed: CommandExecutionFailure;
	executed: CommandExecutionResult[];
}

export type RunPlanResult = RunPlanSuccess | RunPlanFailure;

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function resolveStartCursor(cursor: ExecutionCursor): ExecutionCursor {
	if (cursor.stepIndex === -1 && cursor.commandIndex === -1) {
		return { stepIndex: 0, commandIndex: 0 };
	}
	return cursor;
}

function makeFailure(
	command: string,
	stepIndex: number,
	commandIndex: number,
	error: unknown,
): CommandExecutionFailure {
	return {
		ok: false,
		command,
		stepIndex,
		commandIndex,
		exitCode: 1,
		error: toErrorMessage(error),
	};
}

export async function runPlan(
	plan: Plan,
	startCursor: ExecutionCursor,
	deps: PlanExecutionDeps,
): Promise<RunPlanResult> {
	const cursorCheck = validateCursorJson(startCursor);
	if (!cursorCheck.ok) {
		throw new Error(cursorCheck.errors.join("; "));
	}

	const start = resolveStartCursor(cursorCheck.cursor);
	const executed: CommandExecutionResult[] = [];

	for (
		let stepIndex = start.stepIndex;
		stepIndex < plan.steps.length;
		stepIndex += 1
	) {
		const step = plan.steps[stepIndex];
		if (!step) break;

		if (deps.skipStepIndices?.has(stepIndex)) {
			continue;
		}

		const beginCommandIndex =
			stepIndex === start.stepIndex ? start.commandIndex : 0;
		if (!Number.isInteger(beginCommandIndex) || beginCommandIndex < 0) {
			throw new Error(`Invalid cursor commandIndex: ${beginCommandIndex}`);
		}
		if (beginCommandIndex > step.commands.length) {
			throw new Error(
				`Cursor commandIndex out of range: stepIndex=${stepIndex}, commandIndex=${beginCommandIndex}, commands=${step.commands.length}`,
			);
		}

		for (
			let commandIndex = beginCommandIndex;
			commandIndex < step.commands.length;
			commandIndex += 1
		) {
			const command = step.commands[commandIndex];
			if (!command) continue;

			deps.onCommandStart?.({ stepIndex, commandIndex }, command);

			let result: CommandExecutionResult;
			try {
				result = await deps.executeCommand(command, {
					stepIndex,
					commandIndex,
				});
			} catch (error) {
				const failure = makeFailure(command, stepIndex, commandIndex, error);
				deps.onCommandComplete?.(failure);
				executed.push(failure);
				return {
					ok: false,
					cursor: { stepIndex, commandIndex },
					failed: failure,
					executed,
				};
			}

			deps.onCommandComplete?.(result);
			executed.push(result);
			if (!result.ok || result.exitCode !== 0) {
				const failure: CommandExecutionFailure = result;
				return {
					ok: false,
					cursor: { stepIndex, commandIndex },
					failed: failure,
					executed,
				};
			}
		}
	}

	return {
		ok: true,
		cursor: { stepIndex: -1, commandIndex: -1 },
		executed,
	};
}
