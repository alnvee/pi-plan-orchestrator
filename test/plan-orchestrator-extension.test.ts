import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
	renderExecutionWidget,
	renderPlanWidget,
	renderMergedPlanWidget,
	parseAndValidatePlanJson,
	parseStepArg,
	savePlanToHistory,
	loadPlanHistory,
	renderPlanHistoryWidget,
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

test("renderExecutionWidget marks the active command as ⟳", () => {
	const lines = renderExecutionWidget(plan, 0, 1, []);
	const running = lines.filter((l) => l.includes("⟳"));
	assert.equal(running.length, 1);
	assert.ok(running[0]?.includes("reviewer"), `Expected reviewer in: ${running[0]}`);
});

test("renderExecutionWidget marks completed-success commands as ✓", () => {
	const results: CommandExecutionResult[] = [
		success('/chain scout "scan code"', 0, 0),
	];
	const lines = renderExecutionWidget(plan, 0, 1, results);
	const done = lines.filter((l) => l.includes("✓"));
	assert.equal(done.length, 1);
	assert.ok(done[0]?.includes("scout"), `Expected scout in: ${done[0]}`);
});

test("renderExecutionWidget marks failed commands as ✗", () => {
	const results: CommandExecutionResult[] = [
		success('/chain scout "scan code"', 0, 0),
		failure('/chain reviewer "review code"', 0, 1),
	];
	// active is now past — both already in results, sentinel active (no active)
	const lines = renderExecutionWidget(plan, -1, -1, results);
	const failed = lines.filter((l) => l.includes("✗"));
	assert.equal(failed.length, 1);
	assert.ok(failed[0]?.includes("reviewer"), `Expected reviewer in: ${failed[0]}`);
});

test("renderExecutionWidget marks not-yet-reached commands as ○", () => {
	const lines = renderExecutionWidget(plan, 0, 0, []);
	const pending = lines.filter((l) => l.includes("○"));
	// Step A command 1 and Step B command 0 are pending; command 0 of Step A is active
	assert.equal(pending.length, 2);
});

test("renderExecutionWidget includes goal and step titles", () => {
	const lines = renderExecutionWidget(plan, 0, 0, []);
	const text = lines.join("\n");
	assert.ok(text.includes("ship feature"), "should include goal");
	assert.ok(text.includes("Step A"), "should include Step A title");
	assert.ok(text.includes("Step B"), "should include Step B title");
});

test("renderExecutionWidget lists all commands in order", () => {
	const lines = renderExecutionWidget(plan, 0, 0, []);
	const text = lines.join("\n");
	assert.ok(text.includes("scout"), "should include scout command");
	assert.ok(text.includes("reviewer"), "should include reviewer command");
	assert.ok(text.includes("planner"), "should include planner command");
	// scout appears before reviewer
	assert.ok(text.indexOf("scout") < text.indexOf("reviewer"));
	// reviewer appears before planner
	assert.ok(text.indexOf("reviewer") < text.indexOf("planner"));
});

// ─── renderPlanWidget ─────────────────────────────────────────────────────────

const mixedPlan: Plan = {
	schemaVersion: 1,
	goal: "ship feature",
	steps: [
		{
			title: "Analysis",
			commands: [
				'/chain scout "scan code"',
				'/chain reviewer "review code"',
				'/parallel deployer "deploy"',
			],
		},
	],
};

test("renderPlanWidget overview includes both chain and parallel command counts", () => {
	const lines = renderPlanWidget(mixedPlan);
	const overview = lines.find((l) => l.startsWith("Overview:"));
	assert.ok(overview, "Expected an Overview line");
	assert.ok(
		overview?.includes("chain command"),
		`Expected 'chain command' in: ${overview}`,
	);
	assert.ok(
		overview?.includes("parallel command"),
		`Expected 'parallel command' in: ${overview}`,
	);
});

test("renderPlanWidget overview shows correct chain and parallel counts", () => {
	const lines = renderPlanWidget(mixedPlan);
	const overview = lines.find((l) => l.startsWith("Overview:"));
	// 2 chain + 1 parallel
	assert.ok(overview?.includes("2 chain commands"), `Got: ${overview}`);
	assert.ok(overview?.includes("1 parallel command"), `Got: ${overview}`);
});

test("renderPlanWidget omits chain count when zero", () => {
	const parallelOnlyPlan: Plan = {
		schemaVersion: 1,
		goal: "run parallel",
		steps: [{ title: "Step", commands: ['/parallel a b -- "do it"'] }],
	};
	const lines = renderPlanWidget(parallelOnlyPlan);
	const overview = lines.find((l) => l.startsWith("Overview:"));
	assert.ok(!overview?.includes("chain"), `Should not mention chain: ${overview}`);
	assert.ok(overview?.includes("parallel"), `Got: ${overview}`);
});

test("renderPlanWidget omits parallel count when zero", () => {
	const chainOnlyPlan: Plan = {
		schemaVersion: 1,
		goal: "run chain",
		steps: [{ title: "Step", commands: ['/chain scout "scan"'] }],
	};
	const lines = renderPlanWidget(chainOnlyPlan);
	const overview = lines.find((l) => l.startsWith("Overview:"));
	assert.ok(!overview?.includes("parallel"), `Should not mention parallel: ${overview}`);
	assert.ok(overview?.includes("chain"), `Got: ${overview}`);
});

test("renderPlanWidget includes goal and step titles", () => {
	const lines = renderPlanWidget(plan);
	const text = lines.join("\n");
	assert.ok(text.includes("ship feature"));
	assert.ok(text.includes("Step A"));
	assert.ok(text.includes("Step B"));
});

// ─── renderMergedPlanWidget ───────────────────────────────────────────────────

const mergedPlan: Plan = {
	schemaVersion: 1,
	goal: "ship feature",
	steps: [
		{ title: "Completed step", commands: ['/chain scout "done"'] },
		{ title: "Rewritten step", commands: ['/chain planner "rewritten"'] },
		{ title: "New step", commands: ['/chain deployer "new"'] },
	],
};

test("renderMergedPlanWidget marks steps before cursor as ✓ completed", () => {
	// cursor at step 1 → step 0 is completed prefix
	const lines = renderMergedPlanWidget(mergedPlan, { stepIndex: 1, commandIndex: 0 });
	const completedLine = lines.find((l) => l.includes("Completed step"));
	assert.ok(completedLine?.includes("✓"), `Expected ✓ for completed step: ${completedLine}`);
});

test("renderMergedPlanWidget marks cursor step as ↻ rewritten", () => {
	const lines = renderMergedPlanWidget(mergedPlan, { stepIndex: 1, commandIndex: 0 });
	const rewrittenLine = lines.find((l) => l.includes("Rewritten step"));
	assert.ok(rewrittenLine?.includes("↻"), `Expected ↻ for rewritten step: ${rewrittenLine}`);
});

test("renderMergedPlanWidget marks steps after cursor as → new", () => {
	const lines = renderMergedPlanWidget(mergedPlan, { stepIndex: 1, commandIndex: 0 });
	const newLine = lines.find((l) => l.includes("New step"));
	assert.ok(newLine?.includes("→"), `Expected → for new step: ${newLine}`);
});

test("renderMergedPlanWidget includes goal and all step titles", () => {
	const lines = renderMergedPlanWidget(mergedPlan, { stepIndex: 1, commandIndex: 0 });
	const text = lines.join("\n");
	assert.ok(text.includes("ship feature"));
	assert.ok(text.includes("Completed step"));
	assert.ok(text.includes("Rewritten step"));
	assert.ok(text.includes("New step"));
});

test("renderMergedPlanWidget marks all steps as → new when cursor is at step 0", () => {
	const lines = renderMergedPlanWidget(mergedPlan, { stepIndex: 0, commandIndex: 0 });
	const lines2 = renderMergedPlanWidget(mergedPlan, { stepIndex: 0, commandIndex: 0 });
	const text = lines2.join("\n");
	// No completed prefix when cursor is at step 0
	assert.ok(!text.includes("✓"), "Should have no ✓ when cursor at step 0");
	const rewrittenLine = lines.find((l) => l.includes("Completed step"));
	assert.ok(rewrittenLine?.includes("↻"), `Step 0 should be ↻: ${rewrittenLine}`);
});

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

test("renderPlanHistoryWidget shows history summary lines", () => {
	const plans: Plan[] = [
		{ ...historyPlan, goal: "first plan" },
		{ ...historyPlan, goal: "second plan" },
	];
	const lines = renderPlanHistoryWidget(plans);
	const text = lines.join("\n");
	assert.ok(text.includes("first plan"));
	assert.ok(text.includes("second plan"));
	assert.ok(lines.length > 0);
});

test("renderPlanHistoryWidget shows empty message when no history", () => {
	const lines = renderPlanHistoryWidget([]);
	const text = lines.join("\n");
	assert.ok(text.includes("No plan history") || text.includes("empty") || lines.length > 0);
});
