import assert from "node:assert/strict";
import { test } from "node:test";

import { runPlan, type CommandExecutionResult } from "../src/plan-execution.ts";
import type { Plan } from "../src/plan-schemas.ts";

const plan: Plan = {
	schemaVersion: 1,
	goal: "ship feature",
	steps: [
		{
			title: "Step A",
			commands: [
				'/chain scout "scan code"',
				'/parallel reviewer "review code"',
			],
		},
		{
			title: "Step B",
			commands: ['/chain planner "plan next step"'],
		},
	],
};

function success(
	command: string,
	stepIndex: number,
	commandIndex: number,
): CommandExecutionResult {
	return { ok: true, command, stepIndex, commandIndex, exitCode: 0 };
}

function failure(
	command: string,
	stepIndex: number,
	commandIndex: number,
	error: string,
): CommandExecutionResult {
	return { ok: false, command, stepIndex, commandIndex, exitCode: 1, error };
}

test("runPlan executes commands sequentially in array order and stops on first failure", async () => {
	const calls: Array<{
		command: string;
		stepIndex: number;
		commandIndex: number;
	}> = [];
	const result = await runPlan(
		plan,
		{ stepIndex: -1, commandIndex: -1 },
		{
			executeCommand: async (command, position) => {
				calls.push({
					command,
					stepIndex: position.stepIndex,
					commandIndex: position.commandIndex,
				});
				if (command === '/parallel reviewer "review code"') {
					return failure(
						command,
						position.stepIndex,
						position.commandIndex,
						"child failed",
					);
				}
				return success(command, position.stepIndex, position.commandIndex);
			},
		},
	);

	assert.deepEqual(calls, [
		{ command: '/chain scout "scan code"', stepIndex: 0, commandIndex: 0 },
		{
			command: '/parallel reviewer "review code"',
			stepIndex: 0,
			commandIndex: 1,
		},
	]);
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("Expected runPlan to fail");
	assert.deepEqual(result.cursor, { stepIndex: 0, commandIndex: 1 });
	assert.equal(result.executed.length, 2);
	assert.equal(result.failed.error, "child failed");
	assert.equal(result.failed.command, '/parallel reviewer "review code"');
});

test("runPlan clears the cursor on full success", async () => {
	const calls: string[] = [];
	const result = await runPlan(
		plan,
		{ stepIndex: -1, commandIndex: -1 },
		{
			executeCommand: async (command, position) => {
				calls.push(`${position.stepIndex}:${position.commandIndex}:${command}`);
				return success(command, position.stepIndex, position.commandIndex);
			},
		},
	);

	assert.deepEqual(calls, [
		'0:0:/chain scout "scan code"',
		'0:1:/parallel reviewer "review code"',
		'1:0:/chain planner "plan next step"',
	]);
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("Expected runPlan to succeed");
	assert.deepEqual(result.cursor, { stepIndex: -1, commandIndex: -1 });
	assert.equal(result.executed.length, 3);
});

test("runPlan starts from the supplied cursor", async () => {
	const calls: string[] = [];
	const result = await runPlan(
		plan,
		{ stepIndex: 0, commandIndex: 1 },
		{
			executeCommand: async (command, position) => {
				calls.push(`${position.stepIndex}:${position.commandIndex}:${command}`);
				return success(command, position.stepIndex, position.commandIndex);
			},
		},
	);

	assert.deepEqual(calls, [
		'0:1:/parallel reviewer "review code"',
		'1:0:/chain planner "plan next step"',
	]);
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("Expected runPlan to succeed");
	assert.deepEqual(result.cursor, { stepIndex: -1, commandIndex: -1 });
});

test("runPlan treats bridge-level errors as failure", async () => {
	const result = await runPlan(
		plan,
		{ stepIndex: -1, commandIndex: -1 },
		{
			executeCommand: async () => {
				throw new Error("slash bridge unavailable");
			},
		},
	);

	assert.equal(result.ok, false);
	if (result.ok) throw new Error("Expected runPlan to fail");
	assert.deepEqual(result.cursor, { stepIndex: 0, commandIndex: 0 });
	assert.match(result.failed.error, /slash bridge unavailable/);
});

test("runPlan calls onCommandStart before executing each command", async () => {
	const events: string[] = [];
	await runPlan(plan, { stepIndex: -1, commandIndex: -1 }, {
		executeCommand: async (command, position) => {
			events.push(`execute:${position.stepIndex}:${position.commandIndex}`);
			return success(command, position.stepIndex, position.commandIndex);
		},
		onCommandStart: (ctx, _command) => {
			events.push(`start:${ctx.stepIndex}:${ctx.commandIndex}`);
		},
	});

	assert.deepEqual(events, [
		"start:0:0", "execute:0:0",
		"start:0:1", "execute:0:1",
		"start:1:0", "execute:1:0",
	]);
});

test("runPlan calls onCommandComplete after each successful command", async () => {
	const completed: Array<{ ok: boolean; stepIndex: number; commandIndex: number }> = [];
	await runPlan(plan, { stepIndex: -1, commandIndex: -1 }, {
		executeCommand: async (command, position) =>
			success(command, position.stepIndex, position.commandIndex),
		onCommandComplete: (result) => {
			completed.push({ ok: result.ok, stepIndex: result.stepIndex, commandIndex: result.commandIndex });
		},
	});

	assert.deepEqual(completed, [
		{ ok: true, stepIndex: 0, commandIndex: 0 },
		{ ok: true, stepIndex: 0, commandIndex: 1 },
		{ ok: true, stepIndex: 1, commandIndex: 0 },
	]);
});

test("runPlan calls onCommandComplete with the failure result when a command fails", async () => {
	const completed: Array<{ ok: boolean }> = [];
	const result = await runPlan(plan, { stepIndex: -1, commandIndex: -1 }, {
		executeCommand: async (command, position) => {
			if (position.stepIndex === 0 && position.commandIndex === 1) {
				return failure(command, position.stepIndex, position.commandIndex, "boom");
			}
			return success(command, position.stepIndex, position.commandIndex);
		},
		onCommandComplete: (r) => { completed.push({ ok: r.ok }); },
	});

	assert.equal(result.ok, false);
	assert.deepEqual(completed, [{ ok: true }, { ok: false }]);
});

test("runPlan calls onCommandComplete when executeCommand throws", async () => {
	const completed: Array<{ ok: boolean }> = [];
	const result = await runPlan(plan, { stepIndex: -1, commandIndex: -1 }, {
		executeCommand: async () => { throw new Error("bridge down"); },
		onCommandComplete: (r) => { completed.push({ ok: r.ok }); },
	});

	assert.equal(result.ok, false);
	assert.deepEqual(completed, [{ ok: false }]);
});

test("runPlan fires callbacks in execution order (start then complete per command)", async () => {
	const events: string[] = [];
	await runPlan(plan, { stepIndex: -1, commandIndex: -1 }, {
		executeCommand: async (command, position) => {
			events.push(`exec:${position.stepIndex}:${position.commandIndex}`);
			return success(command, position.stepIndex, position.commandIndex);
		},
		onCommandStart: (ctx) => { events.push(`start:${ctx.stepIndex}:${ctx.commandIndex}`); },
		onCommandComplete: (r) => { events.push(`done:${r.stepIndex}:${r.commandIndex}`); },
	});

	assert.deepEqual(events, [
		"start:0:0", "exec:0:0", "done:0:0",
		"start:0:1", "exec:0:1", "done:0:1",
		"start:1:0", "exec:1:0", "done:1:0",
	]);
});

test("runPlan still works correctly when callbacks are omitted", async () => {
	const result = await runPlan(plan, { stepIndex: -1, commandIndex: -1 }, {
		executeCommand: async (command, position) =>
			success(command, position.stepIndex, position.commandIndex),
	});
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("Expected success");
	assert.equal(result.executed.length, 3);
});

test("runPlan treats /parallel command failure as a command failure", async () => {
	const parallelPlan: Plan = {
		schemaVersion: 1,
		goal: "review code",
		steps: [
			{
				title: "Parallel review",
				commands: ["/parallel scout reviewer -- check for security issues"],
			},
		],
	};

	const result = await runPlan(
		parallelPlan,
		{ stepIndex: -1, commandIndex: -1 },
		{
			executeCommand: async (command, position) => {
				return failure(
					command,
					position.stepIndex,
					position.commandIndex,
					"one parallel child failed",
				);
			},
		},
	);

	assert.equal(result.ok, false);
	if (result.ok) throw new Error("Expected runPlan to fail");
	assert.deepEqual(result.cursor, { stepIndex: 0, commandIndex: 0 });
	assert.equal(
		result.failed.command,
		"/parallel scout reviewer -- check for security issues",
	);
	assert.match(result.failed.error, /one parallel child failed/);
});

test("runPlan skips steps whose index is in skipStepIndices", async () => {
	const calls: Array<{ command: string; stepIndex: number }> = [];
	const result = await runPlan(plan, { stepIndex: -1, commandIndex: -1 }, {
		executeCommand: async (command, position) => {
			calls.push({ command, stepIndex: position.stepIndex });
			return success(command, position.stepIndex, position.commandIndex);
		},
		skipStepIndices: new Set([0]),
	});
	assert.equal(result.ok, true);
	// Step 0 skipped; only step 1 commands run
	assert.equal(calls.length, 1);
	assert.equal(calls[0].stepIndex, 1);
});

test("runPlan with skipStepIndices still succeeds when all skipped steps would have run", async () => {
	const calls: Array<{ stepIndex: number }> = [];
	const result = await runPlan(plan, { stepIndex: -1, commandIndex: -1 }, {
		executeCommand: async (command, position) => {
			calls.push({ stepIndex: position.stepIndex });
			return success(command, position.stepIndex, position.commandIndex);
		},
		skipStepIndices: new Set([0, 1]),
	});
	assert.equal(result.ok, true);
	assert.equal(calls.length, 0, "No commands should run when all steps are skipped");
});
