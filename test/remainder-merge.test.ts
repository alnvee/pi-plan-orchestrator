import { test } from "node:test";
import assert from "node:assert/strict";

import { mergePlanRemainder, type Plan } from "../src/remainder-merge.ts";

test("mergePlanRemainder preserves prefix and failed-step metadata", () => {
	const original: Plan = {
		schemaVersion: 1,
		goal: "build",
		steps: [
			{
				title: "Step A",
				description: "meta A",
				commands: ['/chain a "t1"', '/parallel p1 "t2"', '/chain a "t3"'],
			},
			{
				title: "Step B",
				description: "meta B",
				commands: ['/chain b "b1"', '/chain b "b2"'],
			},
			{ title: "Step C", commands: ['/parallel c "c1"'] },
		],
	};

	const cursor = { stepIndex: 0, commandIndex: 1 };

	const remainder = {
		schemaVersion: 1,
		steps: [
			{
				title: "SHOULD_BE_IGNORED",
				description: "SHOULD_BE_IGNORED",
				commands: ['/chain a "NEW_2"', '/chain a "NEW_3"'],
			},
			{
				title: "Step B (new)",
				description: "meta B (new)",
				commands: ['/chain b "bNEW"'],
			},
			{
				title: "Step C (new)",
				description: "meta C",
				commands: ['/parallel c "cNEW"'],
			},
		],
	};

	const merged = mergePlanRemainder(original, cursor, remainder);

	// Steps before S: none in this test
	// Failed step metadata preserved
	assert.equal(merged.steps[0].title, original.steps[0].title);
	assert.equal(merged.steps[0].description, original.steps[0].description);

	// Failed step commands: prefix commands[0..C-1] preserved, tail replaced
	assert.deepEqual(merged.steps[0].commands, [
		'/chain a "t1"',
		'/chain a "NEW_2"',
		'/chain a "NEW_3"',
	]);

	// Steps after S fully replaced
	assert.deepEqual(merged.steps[1], remainder.steps[1]);
	assert.deepEqual(merged.steps[2], remainder.steps[2]);
});

test("mergePlanRemainder works when cursor.commandIndex is 0", () => {
	const original: Plan = {
		schemaVersion: 1,
		goal: "build",
		steps: [
			{ title: "Step A", commands: ['/chain a "t1"', '/chain a "t2"'] },
			{
				title: "Step B",
				description: "meta B",
				commands: ['/chain b "b1"', '/chain b "b2"'],
			},
		],
	};

	const cursor = { stepIndex: 1, commandIndex: 0 };

	const remainder = {
		schemaVersion: 1,
		steps: [
			{
				title: "IGNORED",
				description: "IGNORED",
				commands: ['/chain b "bNEW_0"', '/chain b "bNEW_1"'],
			},
		],
	};

	const merged = mergePlanRemainder(original, cursor, remainder);

	// Step A preserved
	assert.deepEqual(merged.steps[0], original.steps[0]);

	// Failed step metadata preserved
	assert.equal(merged.steps[1].title, original.steps[1].title);
	assert.equal(merged.steps[1].description, original.steps[1].description);

	// Commands fully replaced (prefix length = 0)
	assert.deepEqual(merged.steps[1].commands, remainder.steps[0].commands);
});

test("mergePlanRemainder throws on remainder length mismatch", () => {
	const original: Plan = {
		schemaVersion: 1,
		goal: "build",
		steps: [
			{ title: "A", commands: ['/chain a "1"'] },
			{ title: "B", commands: ['/chain b "2"'] },
			{ title: "C", commands: ['/chain c "3"'] },
		],
	};

	const cursor = { stepIndex: 1, commandIndex: 0 };

	// Expected remainder steps = 3 - 1 = 2
	const remainder = {
		schemaVersion: 1,
		steps: [
			{ title: "B", commands: ['/chain b "new"'] },
			// Missing replacement for Step C
		],
	};

	assert.throws(() => mergePlanRemainder(original, cursor, remainder));
});
