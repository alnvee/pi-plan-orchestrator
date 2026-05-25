import assert from "node:assert/strict";
import { test } from "node:test";

import {
	generateValidPlanJson,
	generateValidRemainderJson,
	STRICT_JSON_REPAIR_PROMPT,
} from "../src/planner-loop.ts";

function makeGenerator(outputs: string[]) {
	const prompts: string[] = [];
	let index = 0;
	return {
		prompts,
		generate: async (prompt: string) => {
			prompts.push(prompt);
			const output = outputs[index] ?? outputs[outputs.length - 1] ?? "";
			index += 1;
			return output;
		},
	};
}

test("generateValidPlanJson accepts valid JSON without retry", async () => {
	const plan = {
		schemaVersion: 1,
		goal: "ship feature",
		steps: [
			{ title: "Draft plan", commands: ['/chain planner "draft a plan"'] },
		],
	};
	const generator = makeGenerator([JSON.stringify(plan)]);

	const result = await generateValidPlanJson({
		prompt: "Draft a plan",
		generate: generator.generate,
	});

	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("Expected plan generation to succeed");
	assert.deepEqual(result.value, plan);
	assert.equal(result.attempts, 1);
	assert.deepEqual(generator.prompts, ["Draft a plan"]);
});

test("generateValidPlanJson retries with Fix to strict JSON schema after invalid output", async () => {
	const plan = {
		schemaVersion: 1,
		goal: "ship feature",
		steps: [
			{ title: "Draft plan", commands: ['/chain planner "draft a plan"'] },
		],
	};
	const generator = makeGenerator(["not json", JSON.stringify(plan)]);

	const result = await generateValidPlanJson({
		prompt: "Draft a plan",
		generate: generator.generate,
	});

	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("Expected plan generation to succeed");
	assert.deepEqual(result.value, plan);
	assert.equal(result.attempts, 2);
	assert.equal(generator.prompts.length, 2);
	assert.equal(generator.prompts[0], "Draft a plan");
	assert.match(generator.prompts[1], new RegExp(STRICT_JSON_REPAIR_PROMPT));
});

test("generateValidPlanJson retries when JSON parses but fails schema validation", async () => {
	const plan = {
		schemaVersion: 1,
		goal: "ship feature",
		steps: [
			{ title: "Draft plan", commands: ['/chain planner "draft a plan"'] },
		],
	};
	const generator = makeGenerator([
		JSON.stringify({ schemaVersion: 1, goal: "ship feature", steps: [] }),
		JSON.stringify(plan),
	]);

	const result = await generateValidPlanJson({
		prompt: "Draft a plan",
		generate: generator.generate,
	});

	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("Expected plan generation to succeed");
	assert.deepEqual(result.value, plan);
	assert.equal(result.attempts, 2);
	assert.match(
		generator.prompts[1] ?? "",
		new RegExp(STRICT_JSON_REPAIR_PROMPT),
	);
});

test("generateValidPlanJson stops after two repair retries", async () => {
	const generator = makeGenerator([
		"not json",
		"still not json",
		"definitely still not json",
	]);

	const result = await generateValidPlanJson({
		prompt: "Draft a plan",
		generate: generator.generate,
	});

	assert.equal(result.ok, false);
	if (result.ok) throw new Error("Expected plan generation to fail");
	assert.equal(result.attempts, 3);
	assert.equal(generator.prompts.length, 3);
	assert.match(
		result.errors[0] ?? "",
		/Strict JSON validation failed after 3 attempts/,
	);
	assert.match(result.errors.join("\n"), /Invalid JSON/);
});

test("generateValidPlanJson returns actionable validation errors on exhaustion", async () => {
	const generator = makeGenerator([
		JSON.stringify({ schemaVersion: 1, goal: "ship feature", steps: [] }),
		JSON.stringify({ schemaVersion: 1, goal: "ship feature", steps: [] }),
		JSON.stringify({ schemaVersion: 1, goal: "ship feature", steps: [] }),
	]);

	const result = await generateValidPlanJson({
		prompt: "Draft a plan",
		generate: generator.generate,
	});

	assert.equal(result.ok, false);
	if (result.ok) throw new Error("Expected plan generation to fail");
	assert.match(result.errors.join("\n"), /steps/);
	assert.match(
		result.errors[0] ?? "",
		/Strict JSON validation failed after 3 attempts/,
	);
});

test("generateValidRemainderJson uses the same repair prompt behavior", async () => {
	const remainder = {
		schemaVersion: 1,
		steps: [
			{
				title: "Rewrite failed step",
				commands: ['/parallel reviewer "review the fix"'],
			},
		],
	};
	const generator = makeGenerator(["not json", JSON.stringify(remainder)]);

	const result = await generateValidRemainderJson({
		prompt: "Rewrite the failed step only",
		cursor: { stepIndex: 2, commandIndex: 1 },
		generate: generator.generate,
	});

	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("Expected remainder generation to succeed");
	assert.deepEqual(result.value, remainder);
	assert.equal(result.attempts, 2);
	assert.equal(generator.prompts.length, 2);
	assert.match(
		generator.prompts[1] ?? "",
		new RegExp(STRICT_JSON_REPAIR_PROMPT),
	);
	assert.deepEqual(result.cursor, { stepIndex: 2, commandIndex: 1 });
});

test("generateValidRemainderJson preserves cursor unchanged when retries are exhausted", async () => {
	const cursor = { stepIndex: 2, commandIndex: 1 };
	const generator = makeGenerator(["bad", "still bad", "also bad"]);

	const result = await generateValidRemainderJson({
		prompt: "Rewrite the failed step only",
		cursor,
		generate: generator.generate,
	});

	assert.equal(result.ok, false);
	if (result.ok) throw new Error("Expected remainder generation to fail");
	assert.deepEqual(result.cursor, cursor);
	assert.equal(result.attempts, 3);
	assert.match(
		result.errors[0] ?? "",
		/Strict JSON validation failed after 3 attempts/,
	);
});

test("planner loop distinguishes JSON parse failure from schema-shape failure without weakening validation", async () => {
	const plan = {
		schemaVersion: 1,
		goal: "ship feature",
		steps: [
			{ title: "Draft plan", commands: ['/chain planner "draft a plan"'] },
		],
	};
	const generator = makeGenerator([
		"not json",
		JSON.stringify({
			schemaVersion: 1,
			goal: "ship feature",
			steps: [
				{ title: "Draft plan", commands: ['/run planner "draft a plan"'] },
			],
		}),
		JSON.stringify(plan),
	]);

	const result = await generateValidPlanJson({
		prompt: "Draft a plan",
		generate: generator.generate,
	});

	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("Expected plan generation to succeed");
	assert.deepEqual(result.value, plan);
	assert.equal(result.attempts, 3);
	assert.match(
		generator.prompts[1] ?? "",
		new RegExp(STRICT_JSON_REPAIR_PROMPT),
	);
	assert.match(
		generator.prompts[2] ?? "",
		new RegExp(STRICT_JSON_REPAIR_PROMPT),
	);
});
