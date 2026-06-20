import assert from "node:assert/strict";
import { test } from "node:test";

import {
	collectResumeEvidence,
	type SessionEntryLike,
} from "../src/resume-evidence.ts";
import { PLAN_SESSION_CURSOR_PHASE_CUSTOM_TYPE } from "../src/plan-session-state.ts";

function customMessage(content: string): SessionEntryLike {
	return {
		type: "custom_message",
		customType: "subagent-slash-result",
		content,
	};
}

test("collectResumeEvidence ignores placeholders and returns completed-prefix evidence plus failed-command evidence", () => {
	const entries: SessionEntryLike[] = [
		customMessage("Running subagent..."),
		customMessage(
			"## Subagent result\n\nFirst output\n\n## Child session exports\n- /tmp/first",
		),
		customMessage(
			"## Subagent result\n\nSecond output\n\n## Child session exports\n- /tmp/second",
		),
	];

	const result = collectResumeEvidence(entries, {
		stepIndex: 1,
		commandIndex: 0,
	});

	assert.equal(result.entries.length, 2);
	assert.equal(result.completedPrefix.length, 1);
	assert.ok(result.failedCommand);
	assert.match(result.completedPrefix[0]?.content ?? "", /First output/);
	assert.doesNotMatch(
		result.completedPrefix[0]?.content ?? "",
		/Child session exports/,
	);
	assert.match(result.failedCommand?.content ?? "", /Second output/);
	assert.doesNotMatch(
		result.failedCommand?.content ?? "",
		/Child session exports/,
	);
});

test("collectResumeEvidence ignores non-subagent entries and entries without the result heading", () => {
	const entries: SessionEntryLike[] = [
		{
			type: "custom_message",
			customType: "other-entry",
			content: "## Subagent result\n\nIgnored",
		},
		{ type: "message", content: "## Subagent result\n\nIgnored" },
		customMessage("No result heading here"),
		customMessage("## Subagent result\n\nKept"),
	];

	const result = collectResumeEvidence(entries, {
		stepIndex: -1,
		commandIndex: -1,
	});

	assert.equal(result.entries.length, 1);
	assert.equal(result.completedPrefix.length, 1);
	assert.equal(result.failedCommand, undefined);
	assert.equal(result.entries[0]?.executionIndex, 0);
	assert.match(result.entries[0]?.content ?? "", /Kept/);
});

test("collectResumeEvidence truncates evidence blobs to ~8000 chars", () => {
	const hugeBody = "x".repeat(9000);
	const entries: SessionEntryLike[] = [
		customMessage(`## Subagent result\n\n${hugeBody}`),
	];

	const result = collectResumeEvidence(entries, {
		stepIndex: -1,
		commandIndex: -1,
	});

	assert.equal(result.entries.length, 1);
	assert.equal(result.entries[0]?.content.length, 8000);
});

test("collectResumeEvidence preserves chronological mapping from executed command index to final evidence entry", () => {
	const entries: SessionEntryLike[] = [
		customMessage("## Subagent result\n\nOne"),
		customMessage("## Subagent result\n\nTwo"),
		customMessage("## Subagent result\n\nThree"),
	];

	const result = collectResumeEvidence(entries, {
		stepIndex: 3,
		commandIndex: 1,
	});

	assert.deepEqual(
		result.entries.map((entry) => entry.executionIndex),
		[0, 1, 2],
	);
	assert.equal(result.completedPrefix.length, 2);
	assert.match(result.failedCommand?.content ?? "", /Three/);
});

test("collectResumeEvidence accepts minor variations in the '## Subagent result' heading (case and spacing)", () => {
	const entries: SessionEntryLike[] = [
		customMessage("##  Subagent Result\n\nKept"),
		customMessage("## Subagent result\n\nAlso kept"),
	];

	const result = collectResumeEvidence(entries, {
		stepIndex: -1,
		commandIndex: -1,
	});

	assert.equal(result.entries.length, 2);
	assert.match(result.entries[0]?.content ?? "", /Kept/);
	assert.match(result.entries[1]?.content ?? "", /Also kept/);
});

test("collectResumeEvidence accepts '## output' heading (no 'subagent' prefix)", () => {
	const entries: SessionEntryLike[] = [
		customMessage("## Output\n\nKept without subagent prefix"),
	];
	const result = collectResumeEvidence(entries, {
		stepIndex: -1,
		commandIndex: -1,
	});
	assert.equal(result.entries.length, 1);
	assert.match(
		result.entries[0]?.content ?? "",
		/Kept without subagent prefix/,
	);
});

test("collectResumeEvidence accepts '### subagent result' heading (3 hashes)", () => {
	const entries: SessionEntryLike[] = [
		customMessage("### subagent result\n\nThree-hash heading"),
	];
	const result = collectResumeEvidence(entries, {
		stepIndex: -1,
		commandIndex: -1,
	});
	assert.equal(result.entries.length, 1);
	assert.match(result.entries[0]?.content ?? "", /Three-hash heading/);
});

test("collectResumeEvidence accepts '## subagent output' heading (output variant)", () => {
	const entries: SessionEntryLike[] = [
		customMessage("## subagent output\n\nOutput variant heading"),
	];
	const result = collectResumeEvidence(entries, {
		stepIndex: -1,
		commandIndex: -1,
	});
	assert.equal(result.entries.length, 1);
	assert.match(result.entries[0]?.content ?? "", /Output variant heading/);
});

test("collectResumeEvidence accepts '# output' heading (single hash, no subagent)", () => {
	const entries: SessionEntryLike[] = [
		customMessage("# output\n\nSingle hash output"),
	];
	const result = collectResumeEvidence(entries, {
		stepIndex: -1,
		commandIndex: -1,
	});
	assert.equal(result.entries.length, 1);
	assert.match(result.entries[0]?.content ?? "", /Single hash output/);
});

test("collectResumeEvidence uses cursor checkpoint phase 'failure' to mark failedCommand", () => {
	const cursor = { stepIndex: 0, commandIndex: 0 };
	const entries: SessionEntryLike[] = [
		customMessage("## Subagent result\n\nFirst output"),
		customMessage("## Subagent result\n\nSecond output"),
		{
			customType: PLAN_SESSION_CURSOR_PHASE_CUSTOM_TYPE,
			data: { cursor, phase: "failure" },
		},
	];

	const result = collectResumeEvidence(entries, cursor);
	assert.equal(result.entries.length, 2);
	assert.equal(result.completedPrefix.length, 1);
	assert.equal(result.failedCommand?.content, result.entries.at(-1)?.content);
	assert.match(result.failedCommand?.content ?? "", /Second output/);
	assert.match(result.completedPrefix[0]?.content ?? "", /First output/);
});

test("collectResumeEvidence suppresses failedCommand when cursor checkpoint phase is 'advance'", () => {
	const cursor = { stepIndex: 0, commandIndex: 0 };
	const entries: SessionEntryLike[] = [
		customMessage("## Subagent result\n\nFirst output"),
		customMessage("## Subagent result\n\nSecond output"),
		{
			customType: PLAN_SESSION_CURSOR_PHASE_CUSTOM_TYPE,
			data: { cursor, phase: "advance" },
		},
	];

	const result = collectResumeEvidence(entries, cursor);
	assert.equal(result.entries.length, 2);
	assert.equal(result.completedPrefix.length, 2);
	assert.equal(result.failedCommand, undefined);
	assert.match(result.completedPrefix.at(-1)?.content ?? "", /Second output/);
});
