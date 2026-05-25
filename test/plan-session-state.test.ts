import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
	loadPlanSessionState,
	savePlanSessionState,
	PLAN_SESSION_CURSOR_CUSTOM_TYPE,
	PLAN_SESSION_SNAPSHOT_FILENAME,
	type PlanSessionManagerLike,
} from "../src/plan-session-state.ts";
import type { Plan } from "../src/plan-schemas.ts";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-plan-orchestrator-"));
}

test("savePlanSessionState writes only the cursor to appendCustomEntry and stores the active plan snapshot separately", () => {
	const sessionDir = makeTempDir();
	const appended: Array<{ customType: string; data: unknown }> = [];
	const sessionManager: PlanSessionManagerLike = {
		getSessionDir: () => sessionDir,
		appendCustomEntry: (customType, data) => {
			appended.push({ customType, data });
			return "cursor-entry-id";
		},
		getEntries: () => [],
	};
	const plan: Plan = {
		schemaVersion: 1,
		goal: "ship feature",
		steps: [
			{ title: "Draft plan", commands: ['/chain planner "draft a plan"'] },
		],
	};
	const cursor = { stepIndex: 0, commandIndex: 1 };

	const result = savePlanSessionState({ sessionManager, plan, cursor });

	assert.equal(result.cursorEntryId, "cursor-entry-id");
	assert.ok(result.snapshotPath.endsWith(PLAN_SESSION_SNAPSHOT_FILENAME));
	assert.deepEqual(appended, [
		{ customType: PLAN_SESSION_CURSOR_CUSTOM_TYPE, data: cursor },
	]);
	assert.equal(fs.existsSync(result.snapshotPath), true);
	assert.deepEqual(
		JSON.parse(fs.readFileSync(result.snapshotPath, "utf8")),
		plan,
	);
});

test("loadPlanSessionState reloads the same active plan snapshot and latest cursor", () => {
	const sessionDir = makeTempDir();
	const sessionManager: PlanSessionManagerLike = {
		getSessionDir: () => sessionDir,
		appendCustomEntry: () => "cursor-entry-id",
		getEntries: () => [
			{
				type: "custom",
				customType: PLAN_SESSION_CURSOR_CUSTOM_TYPE,
				data: { stepIndex: 0, commandIndex: 0 },
			},
			{ type: "custom", customType: "other-entry", data: { ignored: true } },
			{
				type: "custom",
				customType: PLAN_SESSION_CURSOR_CUSTOM_TYPE,
				data: { stepIndex: 2, commandIndex: 1 },
			},
		],
	};
	const plan: Plan = {
		schemaVersion: 1,
		goal: "ship feature",
		steps: [
			{ title: "Draft plan", commands: ['/chain planner "draft a plan"'] },
			{ title: "Review", commands: ['/parallel reviewer "review"'] },
		],
	};
	const snapshotPath = path.join(sessionDir, PLAN_SESSION_SNAPSHOT_FILENAME);
	fs.mkdirSync(sessionDir, { recursive: true });
	fs.writeFileSync(snapshotPath, JSON.stringify(plan, null, 2), "utf8");

	const result = loadPlanSessionState({ sessionManager });

	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("Expected loadPlanSessionState to succeed");
	assert.deepEqual(result.plan, plan);
	assert.deepEqual(result.cursor, { stepIndex: 2, commandIndex: 1 });
	assert.equal(result.snapshotPath, snapshotPath);
});

test("savePlanSessionState stores a cursor-only payload", () => {
	const sessionDir = makeTempDir();
	let appendedData: unknown;
	const sessionManager: PlanSessionManagerLike = {
		getSessionDir: () => sessionDir,
		appendCustomEntry: (_customType, data) => {
			appendedData = data;
			return "cursor-entry-id";
		},
		getEntries: () => [],
	};
	const plan: Plan = {
		schemaVersion: 1,
		goal: "ship feature",
		steps: [
			{ title: "Draft plan", commands: ['/chain planner "draft a plan"'] },
		],
	};
	const cursor = { stepIndex: -1, commandIndex: -1 };

	savePlanSessionState({ sessionManager, plan, cursor });

	assert.deepEqual(appendedData, cursor);
});
