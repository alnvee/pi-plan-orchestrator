import assert from "node:assert/strict";
import { test } from "node:test";

import {
	validateCursorJson,
	validatePlanJson,
	validateRemainderJson,
} from "../src/plan-schemas.ts";

test("validatePlanJson accepts a minimal valid plan", () => {
	const plan = {
		schemaVersion: 1,
		goal: "ship feature",
		steps: [
			{
				title: "Draft plan",
				commands: ['/chain planner "draft a plan"'],
			},
		],
	};

	assert.deepEqual(validatePlanJson(plan), { ok: true, plan });
});

test("validateRemainderJson accepts a minimal valid remainder", () => {
	const remainder = {
		schemaVersion: 1,
		steps: [
			{
				title: "Rewrite failed step",
				commands: ['/parallel reviewer "review the fix"'],
			},
		],
	};

	assert.deepEqual(validateRemainderJson(remainder), { ok: true, remainder });
});

test("validateCursorJson accepts {-1, -1} as no active cursor", () => {
	assert.deepEqual(validateCursorJson({ stepIndex: -1, commandIndex: -1 }), {
		ok: true,
		cursor: { stepIndex: -1, commandIndex: -1 },
	});
});

test("validateCursorJson rejects mixed sentinel cursor values", () => {
	const result = validateCursorJson({ stepIndex: -1, commandIndex: 0 });
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("Expected cursor validation to fail");
	assert.match(result.errors[0] ?? "", /both be -1 or both be non-negative/);
});

test("validateCursorJson rejects non-integer cursor values", () => {
	const result = validateCursorJson({ stepIndex: 0.5, commandIndex: 0 });
	assert.equal(result.ok, false);
});

test("validateCursorJson rejects cursor values less than -1", () => {
	const result = validateCursorJson({ stepIndex: -2, commandIndex: -2 });
	assert.equal(result.ok, false);
});

test("validatePlanJson rejects additional top-level properties", () => {
	const result = validatePlanJson({
		schemaVersion: 1,
		goal: "ship feature",
		steps: [
			{ title: "Draft plan", commands: ['/chain planner "draft a plan"'] },
		],
		extra: true,
	});

	assert.equal(result.ok, false);
});

test("validatePlanJson rejects additional properties inside steps", () => {
	const result = validatePlanJson({
		schemaVersion: 1,
		goal: "ship feature",
		steps: [
			{
				title: "Draft plan",
				commands: ['/chain planner "draft a plan"'],
				extra: true,
			},
		],
	});

	assert.equal(result.ok, false);
});

test("validatePlanJson rejects wrong schemaVersion", () => {
	const result = validatePlanJson({
		schemaVersion: 2,
		goal: "ship feature",
		steps: [
			{ title: "Draft plan", commands: ['/chain planner "draft a plan"'] },
		],
	});

	assert.equal(result.ok, false);
});

test("validatePlanJson rejects empty steps", () => {
	const result = validatePlanJson({
		schemaVersion: 1,
		goal: "ship feature",
		steps: [],
	});
	assert.equal(result.ok, false);
});

test("validatePlanJson rejects empty commands", () => {
	const result = validatePlanJson({
		schemaVersion: 1,
		goal: "ship feature",
		steps: [{ title: "Draft plan", commands: [] }],
	});

	assert.equal(result.ok, false);
});

test("validatePlanJson rejects commands that do not start with /chain or /parallel", () => {
	const result = validatePlanJson({
		schemaVersion: 1,
		goal: "ship feature",
		steps: [{ title: "Draft plan", commands: ['/run planner "draft a plan"'] }],
	});

	assert.equal(result.ok, false);
	if (result.ok) throw new Error("Expected plan validation to fail");
	assert.match(result.errors[0] ?? "", /\/chain or \/parallel/);
});

test("validatePlanJson rejects /chainX and /parallelX token prefixes", () => {
	const badChain = validatePlanJson({
		schemaVersion: 1,
		goal: "ship feature",
		steps: [
			{ title: "Draft plan", commands: ['/chainX planner "draft a plan"'] },
		],
	});

	assert.equal(badChain.ok, false);
	if (badChain.ok) throw new Error("Expected plan validation to fail");
	assert.match(badChain.errors[0] ?? "", /\/chain or \/parallel/);

	const badParallel = validatePlanJson({
		schemaVersion: 1,
		goal: "ship feature",
		steps: [
			{ title: "Draft plan", commands: ['/parallelX reviewer "review"'] },
		],
	});

	assert.equal(badParallel.ok, false);
	if (badParallel.ok) throw new Error("Expected plan validation to fail");
	assert.match(badParallel.errors[0] ?? "", /\/chain or \/parallel/);
});

test("validateRemainderJson rejects plan-shaped input", () => {
	const result = validateRemainderJson({
		schemaVersion: 1,
		goal: "ship feature",
		steps: [
			{ title: "Draft plan", commands: ['/chain planner "draft a plan"'] },
		],
	});

	assert.equal(result.ok, false);
});

test("validatePlanJson rejects remainder-shaped input", () => {
	const result = validatePlanJson({
		schemaVersion: 1,
		steps: [
			{
				title: "Rewrite failed step",
				commands: ['/parallel reviewer "review"'],
			},
		],
	});

	assert.equal(result.ok, false);
});
