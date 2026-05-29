import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
	parseAndValidatePlanJson,
	parseStepArg,
	savePlanToHistory,
	loadPlanHistory,
} from "../src/plan-orchestrator-extension.ts";
import type { Plan } from "../src/plan-schemas.ts";
import type { CommandExecutionResult } from "../src/plan-execution.ts";

const plan: Plan = {
	schemaVersion: 1,
	goal: "ship feature",
	steps: [
		{
			title: "Step A",
			commands: [
				'/chain scout "scan code"',
				'/chain reviewer "review code"',
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
): CommandExecutionResult {
	return { ok: false, command, stepIndex, commandIndex, exitCode: 1, error: "failed" };
}




// ─── parseAndValidatePlanJson ─────────────────────────────────────────────────

const validPlanJson = JSON.stringify({
	schemaVersion: 1,
	goal: "deploy app",
	steps: [{ title: "Build", commands: ['/chain builder "build"'] }],
});

test("parseAndValidatePlanJson returns ok:true with parsed plan for valid JSON", () => {
	const result = parseAndValidatePlanJson(validPlanJson);
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("Expected ok");
	assert.equal(result.plan.goal, "deploy app");
	assert.equal(result.plan.steps[0].title, "Build");
});

test("parseAndValidatePlanJson returns ok:false for non-JSON input", () => {
	const result = parseAndValidatePlanJson("not json at all");
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("Expected failure");
	assert.ok(result.error.length > 0);
});

test("parseAndValidatePlanJson returns ok:false for empty/whitespace input", () => {
	const result = parseAndValidatePlanJson("   ");
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("Expected failure");
	assert.ok(result.error.length > 0);
});

test("parseAndValidatePlanJson returns ok:false when schema validation fails (missing goal)", () => {
	const badPlan = JSON.stringify({ schemaVersion: 1, steps: [] });
	const result = parseAndValidatePlanJson(badPlan);
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("Expected failure");
	assert.ok(result.error.length > 0);
});

// ─── parseStepArg ─────────────────────────────────────────────────────────────

test("parseStepArg returns ok:true with stepNumber for 'step 1'", () => {
	const result = parseStepArg("step 1");
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("Expected ok");
	assert.equal(result.stepNumber, 1);
});

test("parseStepArg returns ok:true with stepNumber for 'step 3'", () => {
	const result = parseStepArg("step 3");
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("Expected ok");
	assert.equal(result.stepNumber, 3);
});

test("parseStepArg returns ok:false for 'step 0' (must be >= 1)", () => {
	const result = parseStepArg("step 0");
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("Expected failure");
	assert.ok(result.error.length > 0);
});

test("parseStepArg returns ok:false for 'step abc'", () => {
	const result = parseStepArg("step abc");
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("Expected failure");
	assert.ok(result.error.length > 0);
});

test("parseStepArg returns ok:false for 'step' with no number", () => {
	const result = parseStepArg("step");
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("Expected failure");
	assert.ok(result.error.length > 0);
});

// ─── savePlanToHistory / loadPlanHistory ─────────────────────────────────────

function makeTempHistoryDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-plan-hist-"));
}

const historyPlan: Plan = {
	schemaVersion: 1,
	goal: "deploy service",
	steps: [{ title: "Build", commands: ['/chain builder "build"'] }],
};

test("savePlanToHistory creates history file and loadPlanHistory returns saved plan", () => {
	const dir = makeTempHistoryDir();
	savePlanToHistory(dir, historyPlan);
	const history = loadPlanHistory(dir);
	assert.equal(history.length, 1);
	assert.equal(history[0]?.goal, "deploy service");
});

test("loadPlanHistory returns empty array when no history file exists", () => {
	const dir = makeTempHistoryDir();
	const history = loadPlanHistory(dir);
	assert.deepEqual(history, []);
});

test("loadPlanHistory returns at most 5 plans (most recent last 5)", () => {
	const dir = makeTempHistoryDir();
	for (let i = 1; i <= 7; i++) {
		savePlanToHistory(dir, { ...historyPlan, goal: `goal ${i}` });
	}
	const history = loadPlanHistory(dir);
	assert.equal(history.length, 5);
	assert.equal(history[0]?.goal, "goal 3"); // oldest of the last 5
	assert.equal(history[4]?.goal, "goal 7"); // most recent
});

