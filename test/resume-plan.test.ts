import assert from "node:assert/strict";
import { test } from "node:test";

import { resumePlan } from "../src/resume-plan.ts";
import type { Plan } from "../src/plan-schemas.ts";
import type { LoadPlanSessionStateResult } from "../src/plan-session-state.ts";
import type { PlanRemainder } from "../src/plan-schemas.ts";
import type { SessionEntryLike } from "../src/resume-evidence.ts";

function finalResult(content: string): SessionEntryLike {
	return {
		type: "custom_message",
		customType: "subagent-slash-result",
		content,
	};
}

function makePlan(): Plan {
	return {
		schemaVersion: 1,
		goal: "ship feature",
		steps: [
			{
				title: "Step A",
				description: "meta A",
				commands: [
					'/chain scout "scan code"',
					'/parallel reviewer "review code"',
				],
			},
			{
				title: "Step B",
				description: "meta B",
				commands: ['/chain planner "plan next step"'],
			},
		],
	};
}

test("resumePlan merges adapted remainder into the active plan and resumes from the failed command", async () => {
	const plan = makePlan();
	const cursor = { stepIndex: 0, commandIndex: 1 };
	const entries: SessionEntryLike[] = [
		finalResult("Running subagent..."),
		finalResult(
			"## Subagent result\n\nFirst output\n\n## Child session exports\n- first",
		),
		finalResult(
			"## Subagent result\n\nSecond output\n\n## Child session exports\n- second",
		),
	];
	const loaded: LoadPlanSessionStateResult = {
		ok: true,
		plan,
		cursor,
		snapshotPath: "/tmp/session/plan-orchestrator.active-plan.json",
	};
	const prompts: string[] = [];
	const calls: Array<{
		command: string;
		stepIndex: number;
		commandIndex: number;
	}> = [];

	const result = await resumePlan({
		loadPlanSessionState: async () => loaded,
		getEntries: () => entries,
		generateValidRemainderJson: async ({
			prompt,
			cursor: remainderCursor,
			generate,
		}) => {
			prompts.push(prompt);
			assert.deepEqual(remainderCursor, cursor);
			assert.equal(typeof generate, "function");
			const remainder: PlanRemainder = {
				schemaVersion: 1,
				steps: [
					{
						title: "Step A",
						description: "meta A updated",
						commands: ['/parallel reviewer "recheck"'],
					},
					{
						title: "Step B (updated)",
						description: "meta B (updated)",
						commands: ['/chain planner "replan"'],
					},
				],
			};
			return {
				ok: true,
				value: remainder,
				attempts: 1,
				prompts: [prompt],
				cursor: remainderCursor,
			};
		},
		generateRemainder: async () => JSON.stringify({}),
		executeCommand: async (command, position) => {
			calls.push({
				command,
				stepIndex: position.stepIndex,
				commandIndex: position.commandIndex,
			});
			return {
				ok: true,
				command,
				stepIndex: position.stepIndex,
				commandIndex: position.commandIndex,
				exitCode: 0,
			};
		},
	});

	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("Expected resumePlan to succeed");
	assert.equal(prompts.length, 1);
	assert.match(prompts[0], /First output/);
	assert.match(prompts[0], /Second output/);
	assert.doesNotMatch(prompts[0], /Running subagent/);
	assert.equal(result.evidence.completedPrefix.length, 1);
	assert.match(
		result.evidence.completedPrefix[0]?.content ?? "",
		/First output/,
	);
	assert.match(result.evidence.failedCommand?.content ?? "", /Second output/);
	assert.equal(result.mergedPlan.steps[0].title, plan.steps[0].title);
	assert.equal(
		result.mergedPlan.steps[0].description,
		plan.steps[0].description,
	);
	assert.deepEqual(result.mergedPlan.steps[0].commands, [
		'/chain scout "scan code"',
		'/parallel reviewer "recheck"',
	]);
	assert.equal(result.mergedPlan.steps[1].title, "Step B (updated)");
	assert.equal(result.mergedPlan.steps[1].description, "meta B (updated)");
	assert.deepEqual(result.mergedPlan.steps[1].commands, [
		'/chain planner "replan"',
	]);
	assert.deepEqual(calls, [
		{ command: '/parallel reviewer "recheck"', stepIndex: 0, commandIndex: 1 },
		{ command: '/chain planner "replan"', stepIndex: 1, commandIndex: 0 },
	]);
	assert.equal(result.execution.ok, true);
	if (!result.execution.ok) throw new Error("Expected execution to succeed");
	assert.deepEqual(result.cursor, { stepIndex: -1, commandIndex: -1 });
});

test("resumePlan preserves the cursor when remainder generation exhausts retries", async () => {
	const plan = makePlan();
	const cursor = { stepIndex: 0, commandIndex: 1 };
	const loaded: LoadPlanSessionStateResult = {
		ok: true,
		plan,
		cursor,
		snapshotPath: "/tmp/session/plan-orchestrator.active-plan.json",
	};
	let executionCalled = false;

	const result = await resumePlan({
		loadPlanSessionState: async () => loaded,
		getEntries: () => [finalResult("## Subagent result\n\nOne")],
		generateValidRemainderJson: async ({ cursor: remainderCursor }) => {
			return {
				ok: false,
				errors: ["Strict JSON validation failed after 3 attempts"],
				attempts: 3,
				prompts: [
					"Draft",
					"Fix to strict JSON schema",
					"Fix to strict JSON schema",
				],
				cursor: remainderCursor,
			};
		},
		generateRemainder: async () => JSON.stringify({}),
		executeCommand: async () => {
			executionCalled = true;
			return {
				ok: true,
				command: "x",
				stepIndex: 0,
				commandIndex: 0,
				exitCode: 0,
			};
		},
	});

	assert.equal(result.ok, false);
	if (result.ok) throw new Error("Expected resumePlan to fail");
	assert.deepEqual(result.cursor, cursor);
	assert.equal(executionCalled, false);
	assert.match(
		result.errors.join("\n"),
		/Strict JSON validation failed after 3 attempts/,
	);
	assert.equal(result.evidence?.completedPrefix.length, 0);
	assert.match(result.evidence?.failedCommand?.content ?? "", /One/);
});

test("resumePlan aborts execution when onMergedPlanReady returns false", async () => {
	const plan = makePlan();
	const cursor = { stepIndex: 0, commandIndex: 1 };
	const loaded: LoadPlanSessionStateResult = {
		ok: true,
		plan,
		cursor,
		snapshotPath: "/tmp/session/plan-orchestrator.active-plan.json",
	};
	let executionCalled = false;
	let callbackArgs: { mergedPlan: unknown; cursor: unknown } | undefined;

	const result = await resumePlan({
		loadPlanSessionState: async () => loaded,
		getEntries: () => [finalResult("## Subagent result\n\nOne")],
		generateValidRemainderJson: async ({ cursor: remainderCursor }) => {
			const remainder: PlanRemainder = {
				schemaVersion: 1,
				steps: [
					{ title: "Step A", commands: ['/chain p "x"'] },
					{ title: "Step B", commands: ['/chain q "y"'] },
				],
			};
			return { ok: true, value: remainder, attempts: 1, prompts: [], cursor: remainderCursor };
		},
		generateRemainder: async () => "{}",
		executeCommand: async () => {
			executionCalled = true;
			return { ok: true, command: "x", stepIndex: 0, commandIndex: 0, exitCode: 0 };
		},
		onMergedPlanReady: async (mergedPlan, mergeCursor) => {
			callbackArgs = { mergedPlan, cursor: mergeCursor };
			return false; // abort
		},
	});

	assert.equal(result.ok, false);
	if (result.ok) throw new Error("Expected resumePlan to be aborted");
	assert.equal(executionCalled, false, "executeCommand should not be called");
	assert.ok(callbackArgs, "onMergedPlanReady should have been called");
	assert.deepEqual((callbackArgs!.cursor as typeof cursor), cursor);
	assert.match(result.errors.join("\n"), /abort/i);
});

test("resumePlan proceeds when onMergedPlanReady returns true", async () => {
	const plan = makePlan();
	const cursor = { stepIndex: 0, commandIndex: 1 };
	const loaded: LoadPlanSessionStateResult = {
		ok: true,
		plan,
		cursor,
		snapshotPath: "/tmp/session/plan-orchestrator.active-plan.json",
	};
	let executionCalled = false;

	const result = await resumePlan({
		loadPlanSessionState: async () => loaded,
		getEntries: () => [finalResult("## Subagent result\n\nOne")],
		generateValidRemainderJson: async ({ cursor: remainderCursor }) => {
			const remainder: PlanRemainder = {
				schemaVersion: 1,
				steps: [
					{ title: "Step A", commands: ['/chain p "x"'] },
					{ title: "Step B", commands: ['/chain q "y"'] },
				],
			};
			return { ok: true, value: remainder, attempts: 1, prompts: [], cursor: remainderCursor };
		},
		generateRemainder: async () => "{}",
		executeCommand: async (command, position) => {
			executionCalled = true;
			return { ok: true, command, stepIndex: position.stepIndex, commandIndex: position.commandIndex, exitCode: 0 };
		},
		onMergedPlanReady: async () => true, // proceed
	});

	assert.equal(result.ok, true);
	assert.equal(executionCalled, true, "executeCommand should be called when approved");
});
