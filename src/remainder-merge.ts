export type PlanStep = {
	title: string;
	description?: string;
	commands: string[];
};

export type Plan = {
	schemaVersion: number;
	goal: string;
	steps: PlanStep[];
};

export type PlanRemainder = {
	schemaVersion: number;
	/** Steps array starting at cursor.stepIndex */
	steps: PlanStep[];
};

export type ExecutionCursor = {
	/** Next (uncompleted) step index */
	stepIndex: number;
	/** Next (uncompleted) command index within the step */
	commandIndex: number;
};

/**
 * Applies remainder-only plan rewriting.
 *
 * Rules:
 * - Steps < cursor.stepIndex are preserved exactly.
 * - For failed step S == cursor.stepIndex:
 *   - preserve commands[0..C-1] byte-for-byte
 *   - replace only commands[C..] with remainder.steps[0].commands
 *   - preserve step metadata (title/description) byte-for-byte
 * - Steps after S may be fully rewritten from remainder.steps[1..]
 */
export function mergePlanRemainder(
	original: Plan,
	cursor: ExecutionCursor,
	remainder: PlanRemainder,
): Plan {
	const { stepIndex: S, commandIndex: C } = cursor;

	if (S < 0 || C < 0) {
		// Nothing to merge (no active cursor)
		return original;
	}

	if (!Number.isInteger(S) || !Number.isInteger(C)) {
		throw new Error(`Invalid cursor: stepIndex=${S}, commandIndex=${C}`);
	}

	if (S >= original.steps.length) {
		throw new Error(
			`Cursor stepIndex out of range: S=${S}, steps=${original.steps.length}`,
		);
	}

	const originalStep = original.steps[S];
	// Cursor.commandIndex must point at an existing (failed/uncompleted) command.
	if (C >= originalStep.commands.length) {
		throw new Error(
			`Cursor commandIndex out of range: C=${C}, commands=${originalStep.commands.length}`,
		);
	}

	const expectedRemainderSteps = original.steps.length - S;
	if (remainder.steps.length !== expectedRemainderSteps) {
		throw new Error(
			`Remainder steps length mismatch: expected ${expectedRemainderSteps} (from S=${S}), got ${remainder.steps.length}`,
		);
	}

	if (remainder.steps.length < 1) {
		throw new Error("Remainder must include at least the failed step");
	}

	const failedStepReplacement = remainder.steps[0];
	if (!Array.isArray(failedStepReplacement.commands)) {
		throw new Error("Invalid remainder: first step must include commands[]");
	}
	if (failedStepReplacement.commands.length < 1) {
		throw new Error(
			"Invalid remainder: replacement commands[] for failed step must be non-empty",
		);
	}

	const nextSteps: PlanStep[] = original.steps.map((step, i) => {
		if (i < S) return step;

		if (i === S) {
			const mergedCommands = originalStep.commands
				.slice(0, C)
				.concat(failedStepReplacement.commands);
			// Preserve step metadata exactly
			return {
				...step,
				commands: mergedCommands,
			};
		}

		const replacementStep = remainder.steps[i - S];
		if (!replacementStep) {
			// Should be impossible given length check above.
			throw new Error(`Missing replacement step for index ${i}`);
		}

		return replacementStep;
	});

	return {
		...original,
		steps: nextSteps,
	};
}
