import * as fs from "node:fs";
import * as path from "node:path";

import {
	validateCursorJson,
	validatePlanJson,
	type ExecutionCursor,
	type Plan,
} from "./plan-schemas.ts";

export const PLAN_SESSION_CURSOR_CUSTOM_TYPE = "plan-orchestrator-cursor";
export const PLAN_SESSION_SNAPSHOT_FILENAME =
	"plan-orchestrator.active-plan.json";

export interface PlanSessionManagerLike {
	getSessionDir(): string;
	appendCustomEntry(customType: string, data?: unknown): string;
	getEntries(): Array<{ type: string; customType?: string; data?: unknown }>;
}

export interface SavePlanSessionStateInput {
	sessionManager: PlanSessionManagerLike;
	plan: Plan;
	cursor: ExecutionCursor;
}

export interface SavePlanSessionStateResult {
	cursorEntryId: string;
	snapshotPath: string;
}

export interface LoadPlanSessionStateInput {
	sessionManager: PlanSessionManagerLike;
	snapshotPath?: string;
}

export interface LoadPlanSessionStateSuccess {
	ok: true;
	plan: Plan;
	cursor: ExecutionCursor;
	snapshotPath: string;
}

export interface LoadPlanSessionStateFailure {
	ok: false;
	errors: string[];
}

export type LoadPlanSessionStateResult =
	| LoadPlanSessionStateSuccess
	| LoadPlanSessionStateFailure;

function getDefaultSnapshotPath(sessionDir: string): string {
	return path.join(sessionDir, PLAN_SESSION_SNAPSHOT_FILENAME);
}

function readJsonFile(
	filePath: string,
): { ok: true; value: unknown } | { ok: false; errors: string[] } {
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		return { ok: true, value: JSON.parse(raw) };
	} catch (error) {
		return {
			ok: false,
			errors: [
				error instanceof Error
					? `Failed to read ${filePath}: ${error.message}`
					: `Failed to read ${filePath}: ${String(error)}`,
			],
		};
	}
}

function findLatestCursorEntry(
	entries: Array<{ type: string; customType?: string; data?: unknown }>,
): { type: string; customType?: string; data?: unknown } | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!entry || entry.type !== "custom") continue;
		if (entry.customType !== PLAN_SESSION_CURSOR_CUSTOM_TYPE) continue;
		return entry;
	}
	return undefined;
}

export function savePlanSessionState(
	input: SavePlanSessionStateInput,
): SavePlanSessionStateResult {
	const planCheck = validatePlanJson(input.plan);
	if (!planCheck.ok) {
		throw new Error(`Invalid plan snapshot: ${planCheck.errors.join("; ")}`);
	}

	const cursorCheck = validateCursorJson(input.cursor);
	if (!cursorCheck.ok) {
		throw new Error(
			`Invalid cursor snapshot: ${cursorCheck.errors.join("; ")}`,
		);
	}

	const sessionDir = input.sessionManager.getSessionDir();
	fs.mkdirSync(sessionDir, { recursive: true });
	const snapshotPath = getDefaultSnapshotPath(sessionDir);
	fs.writeFileSync(
		snapshotPath,
		JSON.stringify(planCheck.plan, null, 2),
		"utf8",
	);
	const cursorEntryId = input.sessionManager.appendCustomEntry(
		PLAN_SESSION_CURSOR_CUSTOM_TYPE,
		cursorCheck.cursor,
	);

	return { cursorEntryId, snapshotPath };
}

export function loadPlanSessionState(
	input: LoadPlanSessionStateInput,
): LoadPlanSessionStateResult {
	const sessionDir = input.sessionManager.getSessionDir();
	const snapshotPath = input.snapshotPath ?? getDefaultSnapshotPath(sessionDir);
	if (!fs.existsSync(snapshotPath)) {
		return {
			ok: false,
			errors: [`Missing active plan snapshot: ${snapshotPath}`],
		};
	}

	const planFile = readJsonFile(snapshotPath);
	if (!planFile.ok) return planFile;
	const planCheck = validatePlanJson(planFile.value);
	if (!planCheck.ok) return { ok: false, errors: planCheck.errors };

	const cursorEntry = findLatestCursorEntry(input.sessionManager.getEntries());
	if (!cursorEntry) {
		return {
			ok: false,
			errors: [`Missing cursor entry: ${PLAN_SESSION_CURSOR_CUSTOM_TYPE}`],
		};
	}

	const cursorCheck = validateCursorJson(cursorEntry.data);
	if (!cursorCheck.ok) {
		return { ok: false, errors: cursorCheck.errors };
	}

	return {
		ok: true,
		plan: planCheck.plan,
		cursor: cursorCheck.cursor,
		snapshotPath,
	};
}
