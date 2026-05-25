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
