import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import registerPlanOrchestrator from "../src/index.ts";
import { compileStoredCommand } from "../src/command-compiler.ts";
import {
	SLASH_SUBAGENT_REQUEST_EVENT,
	SLASH_SUBAGENT_RESPONSE_EVENT,
	type SlashBridgeEventBus,
} from "../src/slash-bridge-executor.ts";
import {
	PLAN_SESSION_CURSOR_CUSTOM_TYPE,
	PLAN_SESSION_SNAPSHOT_FILENAME,
} from "../src/plan-session-state.ts";
import type { Plan } from "../src/plan-schemas.ts";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-plan-orchestrator-"));
}

type Entry =
	| {
			type: "message";
			message: {
				role: "assistant";
				content: Array<{ type: "text"; text: string }>;
			};
	  }
	| { type: "custom"; customType: string; data?: unknown };

function createFakePi(args: {
	entries: Entry[];
	sendMessageOutputs: {
		initialPlanJson: string;
		adaptedRemainderJson: string;
	};
	requestOutcomes: Array<{
		exitCode: number;
		errorText?: string;
	}>;
	requestsCaptured?: Array<{ params: unknown }>;
}) {
	const { entries, sendMessageOutputs, requestOutcomes, requestsCaptured } =
		args;
	const commands = new Map<
		string,
		{ handler: (args: string, ctx: any) => Promise<void> }
	>();
	const sendMessageCalls: Array<{
		message: any;
		options: any;
	}> = [];

	let requestCount = 0;
	const listeners = new Map<string, Array<(data: unknown) => void>>();

	const bus: SlashBridgeEventBus = {
		on(event, handler) {
			const handlers = listeners.get(event) ?? [];
			handlers.push(handler);
			listeners.set(event, handlers);
			return () => {
				const next = (listeners.get(event) ?? []).filter((h) => h !== handler);
				listeners.set(event, next);
			};
		},
		emit(event, data) {
			// Local helper to deliver to current listeners.
			const deliver = (evt: string, payload: unknown) => {
				for (const handler of listeners.get(evt) ?? []) handler(payload);
			};

			if (event === SLASH_SUBAGENT_REQUEST_EVENT) {
				const outcome = requestOutcomes[requestCount] ?? {
					exitCode: 1,
					errorText: "Unexpected slash-bridge request",
				};
				requestCount += 1;

				requestsCaptured?.push({ params: (data as any).params });

				const requestId = (data as any).requestId;
				const exitCode = outcome.exitCode;

				deliver(SLASH_SUBAGENT_RESPONSE_EVENT, {
					requestId,
					isError: false,
					result: {
						content: [
							{ type: "text", text: exitCode === 0 ? "done" : "failed" },
						],
						details: {
							results:
								exitCode === 0
									? [{ agent: "any", exitCode: 0 }]
									: [
											{
												agent: "any",
												exitCode,
												error: outcome.errorText ?? "command failed",
											},
										],
						},
					},
				});
			}

			// Deliver the originally-emitted event too (usually nobody listens to request events).
			deliver(event, data);
		},
	};

	const pi = {
		commands,
		sendMessageCalls,
		registerCommand(
			name: string,
			options: { handler: (args: string, ctx: any) => Promise<void> },
		) {
			commands.set(name, { handler: options.handler });
		},
		appendEntry(customType: string, data?: unknown) {
			entries.push({ type: "custom", customType, data });
		},
		sendMessage: async (message: any, options?: any) => {
			sendMessageCalls.push({ message, options });

			const prompt: unknown = message?.content;
			const promptText = typeof prompt === "string" ? prompt : "";
			const output = promptText.includes("Adapt the remainder")
				? sendMessageOutputs.adaptedRemainderJson
				: sendMessageOutputs.initialPlanJson;

			entries.push({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: output }],
				},
			});
		},

		// Provide on/emit directly on pi so default index.ts can treat pi itself as the event bus.
		on: bus.on,
		emit: bus.emit,
	};

	return pi;
}

function makeUi(overrides?: Partial<any>) {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	return {
		calls,
		setWidget: (
			key: string,
			content: string[] | undefined,
			options?: unknown,
		) => {
			calls.push({ method: "setWidget", args: [key, content, options] });
		},
		editor: async (title: string, prefill?: string) => {
			calls.push({ method: "editor", args: [title, prefill] });
			return overrides?.editor ?? "";
		},
		confirm: async (title: string, message: string) => {
			calls.push({ method: "confirm", args: [title, message] });
			return overrides?.confirm ?? false;
		},
		notify: (message: string, type?: string) => {
			calls.push({ method: "notify", args: [message, type] });
		},
		setWorkingMessage: (_message?: string) => { /* no-op in tests */ },
		setStatus: (_key: string, _value: string | undefined) => { /* no-op in tests */ },
	};
}

function makeCtx(args: {
	sessionDir: string;
	entries: Entry[];
	ui: any;
	hasUI?: boolean;
}) {
	const { sessionDir, entries, ui } = args;
	return {
		hasUI: args.hasUI ?? true,
		ui,
		waitForIdle: async () => {},
		sessionManager: {
			getSessionDir: () => sessionDir,
			getEntries: () => entries,
		},
	} as any;
}

test("default export: /plan-orchestrator runs end-to-end with plannerFactory + slash bridge", async () => {
	const sessionDir = makeTempDir();
	const entries: Entry[] = [];

	const cmd0 = "/chain scout planner -- scan code";
	const initialPlan: Plan = {
		schemaVersion: 1,
		goal: "ship feature",
		steps: [
			{
				title: "Step A",
				commands: [cmd0],
			},
		],
	};

	const expectedReqParams = (() => {
		const compiled = compileStoredCommand(cmd0);
		assert.equal(compiled.ok, true);
		return compiled.ok ? compiled.params : null;
	})();

	const ui = makeUi({ editor: "", confirm: true });
	const requestsCaptured: Array<{ params: unknown }> = [];
	const pi = createFakePi({
		entries,
		sendMessageOutputs: {
			initialPlanJson: JSON.stringify(initialPlan),
			adaptedRemainderJson: JSON.stringify({ schemaVersion: 1, steps: [] }),
		},
		requestOutcomes: [{ exitCode: 0 }, { exitCode: 0 }],
		requestsCaptured,
	});

	registerPlanOrchestrator(pi as any);
	const handler = pi.commands.get("plan-orchestrator")?.handler;
	assert.ok(handler);

	const ctx = makeCtx({ sessionDir, entries, ui, hasUI: true });

	await handler("build a feature", ctx);

	// UI: execution completed.
	const notifyCalls = ui.calls.filter((c: any) => c.method === "notify");
	assert.ok(
		notifyCalls.some(
			(c: any) => c.args[0] === "Plan completed" && c.args[1] === "info",
		),
		"Expected Plan completed notification",
	);

	// Session snapshot written.
	assert.ok(
		fs.existsSync(path.join(sessionDir, PLAN_SESSION_SNAPSHOT_FILENAME)),
		"Expected active-plan snapshot to be written",
	);

	// Cursor entries written (at least: NO_ACTIVE_CURSOR + final cursor).
	const cursorEntries = entries.filter(
		(e) =>
			e.type === "custom" &&
			(e as any).customType === PLAN_SESSION_CURSOR_CUSTOM_TYPE,
	);
	assert.ok(cursorEntries.length >= 2);
	const lastCursor = cursorEntries.at(-1) as any;
	assert.deepEqual(lastCursor.data, { stepIndex: -1, commandIndex: -1 });

	// Slash-bridge executor compiled params correctly.
	assert.equal(requestsCaptured.length, 2);
	assert.deepEqual(
		requestsCaptured[requestsCaptured.length - 1].params,
		expectedReqParams,
	);

	// Planner sendMessage wiring.
	assert.equal(pi.sendMessageCalls.length, 1);
	const send0 = pi.sendMessageCalls[0];
	assert.equal(send0.message.customType, "plan-orchestrator-planner");
	assert.equal(send0.message.display, false);
	assert.deepEqual(send0.message.details, { source: "plan-orchestrator" });
	assert.deepEqual(send0.options, { triggerTurn: true });
});

test("default export: execution failure persists cursor and resume re-plans remainder", async () => {
	const sessionDir = makeTempDir();
	const entries: Entry[] = [];

	const cmd0 = "/chain scout planner -- scan code";
	const cmd1 = "/parallel scout reviewer -- review code";
	const newCmd = "/chain scout planner -- follow up";

	const initialPlan: Plan = {
		schemaVersion: 1,
		goal: "ship feature",
		steps: [
			{
				title: "Step A",
				commands: [cmd0, cmd1],
			},
		],
	};

	const remainderPlan = {
		schemaVersion: 1,
		steps: [
			{
				title: "Replacement",
				// description doesn't matter; mergePlanRemainder preserves original step metadata.
				description: "ignored",
				commands: [newCmd],
			},
		],
	};

	const expectedReqParams = [cmd0, cmd1, newCmd].map((cmd) => {
		const compiled = compileStoredCommand(cmd);
		assert.equal(compiled.ok, true);
		return compiled.ok ? compiled.params : null;
	});

	const ui = makeUi({ editor: "", confirm: true });
	const requestsCaptured: Array<{ params: unknown }> = [];

	const pi = createFakePi({
		entries,
		sendMessageOutputs: {
			initialPlanJson: JSON.stringify(initialPlan),
			adaptedRemainderJson: JSON.stringify(remainderPlan),
		},
		requestOutcomes: [
			{ exitCode: 0 }, // initial context scout
			{ exitCode: 0 }, // cmd0
			{ exitCode: 1, errorText: "second command failed" }, // cmd1
			{ exitCode: 0 }, // resume context scout
			{ exitCode: 0 }, // newCmd
		],
		requestsCaptured,
	});

	registerPlanOrchestrator(pi as any);
	const handler = pi.commands.get("plan-orchestrator")?.handler;
	assert.ok(handler);

	const ctx = makeCtx({ sessionDir, entries, ui, hasUI: true });

	await handler("build a feature", ctx);

	let notifyCalls = ui.calls.filter((c: any) => c.method === "notify");
	assert.ok(
		notifyCalls.some(
			(c: any) =>
				c.args[1] === "error" &&
				typeof c.args[0] === "string" &&
				c.args[0].includes("Execution failed at step 0, command 1"),
		),
		"Expected execution failure notification with cursor location",
	);

	// cursor must be persisted for resume.
	const cursorEntries = entries.filter(
		(e) =>
			e.type === "custom" &&
			(e as any).customType === PLAN_SESSION_CURSOR_CUSTOM_TYPE,
	);
	const lastCursor = cursorEntries.at(-1) as any;
	assert.deepEqual(lastCursor.data, { stepIndex: 0, commandIndex: 1 });

	// Resume.
	await handler("resume", ctx);

	notifyCalls = ui.calls.filter((c: any) => c.method === "notify");
	assert.ok(
		notifyCalls.some(
			(c: any) => c.args[0] === "Resume completed" && c.args[1] === "info",
		),
		"Expected resume completion notification",
	);

	const resumedCursorEntries = entries.filter(
		(e) =>
			e.type === "custom" &&
			(e as any).customType === PLAN_SESSION_CURSOR_CUSTOM_TYPE,
	);
	const finalCursor = resumedCursorEntries.at(-1) as any;
	assert.deepEqual(finalCursor.data, { stepIndex: -1, commandIndex: -1 });

	// Slash-bridge executor compiled params for all three executed commands.
	// Slots: 0=initial scout, 1=cmd0, 2=cmd1, 3=resume scout, 4=newCmd
	assert.equal(requestsCaptured.length, 5);
	assert.deepEqual(requestsCaptured[1].params, expectedReqParams[0]); // cmd0
	assert.deepEqual(requestsCaptured[2].params, expectedReqParams[1]); // cmd1
	assert.deepEqual(requestsCaptured[4].params, expectedReqParams[2]); // newCmd

	// Planner sendMessage wiring: initial plan + adapted remainder.
	assert.equal(pi.sendMessageCalls.length, 2);
	const send0 = pi.sendMessageCalls[0];
	const send1 = pi.sendMessageCalls[1];
	assert.equal(send0.message.customType, "plan-orchestrator-planner");
	assert.equal(send1.message.customType, "plan-orchestrator-planner");
	assert.deepEqual(send0.options, { triggerTurn: true });
	assert.deepEqual(send1.options, { triggerTurn: true });
});
