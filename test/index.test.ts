import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
	registerPlanOrchestratorExtension,
	type PlanOrchestratorDependencies,
} from "../src/plan-orchestrator-extension.ts";
import {
	SLASH_SUBAGENT_REQUEST_EVENT,
	SLASH_SUBAGENT_RESPONSE_EVENT,
} from "../src/slash-bridge-executor.ts";
import {
	PLAN_SESSION_CURSOR_CUSTOM_TYPE,
	PLAN_SESSION_SNAPSHOT_FILENAME,
} from "../src/plan-session-state.ts";
import type { Plan } from "../src/plan-schemas.ts";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-plan-orchestrator-ui-"));
}

function createPlan(): Plan {
	return {
		schemaVersion: 1,
		goal: "ship feature",
		steps: [
			{
				title: "Draft plan",
				description: "Meta",
				commands: [
					'/chain scout "scan code"',
					'/parallel reviewer "review code"',
				],
			},
		],
	};
}

function makePi() {
	const commands = new Map<
		string,
		{ description?: string; handler: (args: string, ctx: any) => Promise<void> }
	>();
	const appended: Array<{ customType: string; data: unknown }> = [];
	const slashBridgeRequests: Array<unknown> = [];

	const listeners = new Map<string, Array<(data: unknown) => void>>();
	const deliver = (evt: string, payload: unknown) => {
		for (const handler of listeners.get(evt) ?? []) handler(payload);
	};

	return {
		commands,
		appended,
		slashBridgeRequests,
		on(event: string, handler: (data: unknown) => void) {
			const handlers = listeners.get(event) ?? [];
			handlers.push(handler);
			listeners.set(event, handlers);
			return () => {
				const next = (listeners.get(event) ?? []).filter((h) => h !== handler);
				listeners.set(event, next);
			};
		},
		emit(event: string, data: unknown) {
			if (event === SLASH_SUBAGENT_REQUEST_EVENT) {
				slashBridgeRequests.push(data);
				const requestId = (data as any).requestId;
				deliver(SLASH_SUBAGENT_RESPONSE_EVENT, {
					requestId,
					isError: false,
					result: {
						content: [{ type: "text", text: "context" }],
						details: {
							results: [{ agent: "any", exitCode: 0 }],
						},
					},
				});
			}

			deliver(event, data);
		},
		registerCommand(
			name: string,
			options: {
				description?: string;
				handler: (args: string, ctx: any) => Promise<void>;
			},
		) {
			commands.set(name, options);
		},
		appendEntry(customType: string, data?: unknown) {
			appended.push({ customType, data });
		},
	};
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
		getSessionDir: () => overrides?.sessionDir,
	};
}

function makeCtx(
	sessionDir: string,
	ui: any,
	entries: any[] = [],
	hasUI: boolean = true,
) {
	return {
		hasUI,
		ui,
		sessionManager: {
			getSessionDir: () => sessionDir,
			getEntries: () => entries,
		},
	} as any;
}

function createDependencies(outputs: {
	plan?: string[];
	remainder?: string[];
	execute?: Array<{
		ok: boolean;
		command: string;
		stepIndex: number;
		commandIndex: number;
		exitCode: number;
		error?: string;
	}>;
}): PlanOrchestratorDependencies {
	const planOutputs = [...(outputs.plan ?? [])];
	const remainderOutputs = [...(outputs.remainder ?? [])];
	const executeOutputs = [...(outputs.execute ?? [])];
	return {
		planner: {
			generatePlan: async () =>
				planOutputs.shift() ?? JSON.stringify(createPlan()),
			generateRemainder: async () =>
				remainderOutputs.shift() ??
				JSON.stringify({ schemaVersion: 1, steps: [] }),
		},
		executeCommand: async (command, context) => {
			const next = executeOutputs.shift();
			if (!next) {
				return {
					ok: true,
					command,
					stepIndex: context.stepIndex,
					commandIndex: context.commandIndex,
					exitCode: 0,
				};
			}
			if (next.ok) {
				return {
					ok: true,
					command,
					stepIndex: context.stepIndex,
					commandIndex: context.commandIndex,
					exitCode: 0,
				};
			}
			return {
				ok: false,
				command,
				stepIndex: context.stepIndex,
				commandIndex: context.commandIndex,
				exitCode: next.exitCode,
				error: next.error ?? "failed",
			};
		},
	};
}

test("/plan-orchestrator shows the plan before execution and waits for approval", async () => {
	const sessionDir = makeTempDir();
	const pi = makePi();
	const ui = makeUi({ editor: "", confirm: false, sessionDir });
	const ctx = makeCtx(sessionDir, ui);
	const deps = createDependencies({ plan: [JSON.stringify(createPlan())] });

	registerPlanOrchestratorExtension(pi as any, deps);
	const handler = pi.commands.get("plan-orchestrator")?.handler;
	assert.ok(handler);
	if (!handler) throw new Error("Missing plan-orchestrator command");

	await handler("build a feature", ctx);

	const widgetCall = ui.calls.find((call: any) => call.method === "setWidget");
	assert.ok(widgetCall);
	assert.deepEqual(widgetCall.args[0], "plan-orchestrator");
	assert.deepEqual(widgetCall.args[1], [
		"Plan orchestrator",
		"Goal: ship feature",
		"",
		"1. Draft plan",
		"   Meta",
		'   /chain scout "scan code"',
		'   /parallel reviewer "review code"',
		"",
	]);
	assert.equal(
		ui.calls.findIndex((call: any) => call.method === "editor") <
			ui.calls.findIndex((call: any) => call.method === "confirm"),
		true,
	);
	assert.equal(
		ui.calls.filter((call: any) => call.method === "confirm").length,
		1,
	);
	assert.equal(pi.appended.length, 0);
	assert.equal(
		fs.existsSync(path.join(sessionDir, PLAN_SESSION_SNAPSHOT_FILENAME)),
		false,
	);
});

test("/plan-orchestrator caches planning context per session (request-keyed)", async () => {
	const sessionDir = makeTempDir();
	const pi = makePi();
	const ui = makeUi({ editor: "", confirm: false, sessionDir });
	const ctx = makeCtx(sessionDir, ui);
	const deps = createDependencies({
		plan: [
			JSON.stringify(createPlan()),
			JSON.stringify(createPlan()),
			JSON.stringify(createPlan()),
		],
	});

	registerPlanOrchestratorExtension(pi as any, deps);
	const handler = pi.commands.get("plan-orchestrator")?.handler;
	assert.ok(handler);
	if (!handler) throw new Error("Missing plan-orchestrator command");

	await handler("build a feature", ctx);
	assert.equal(pi.slashBridgeRequests.length, 1);

	await handler("build a feature", ctx);
	assert.equal(pi.slashBridgeRequests.length, 1);

	await handler("build a feature v2", ctx);
	assert.equal(pi.slashBridgeRequests.length, 2);
});

test("/plan-orchestrator validates refined JSON before execution begins", async () => {
	const sessionDir = makeTempDir();
	const pi = makePi();
	const refinedPlan: Plan = {
		schemaVersion: 1,
		goal: "ship feature",
		steps: [
			{
				title: "Draft plan",
				description: "Meta",
				commands: [
					'/chain scout "scan code"',
					'/parallel reviewer "review code"',
				],
			},
			{
				title: "Review follow-up",
				commands: ['/chain planner "follow up"'],
			},
		],
	};
	const ui = makeUi({ editor: "Make it broader", confirm: true, sessionDir });
	const ctx = makeCtx(sessionDir, ui);
	const deps = createDependencies({
		plan: [
			JSON.stringify(createPlan()),
			"not json",
			JSON.stringify(refinedPlan),
		],
		execute: [
			{ ok: true, command: "", stepIndex: 0, commandIndex: 0, exitCode: 0 },
		],
	});

	registerPlanOrchestratorExtension(pi as any, deps);
	const handler = pi.commands.get("plan-orchestrator")?.handler;
	assert.ok(handler);
	if (!handler) throw new Error("Missing plan-orchestrator command");

	await handler("build a feature", ctx);

	const widgetCalls = ui.calls.filter(
		(call: any) => call.method === "setWidget",
	);
	assert.equal(widgetCalls.length, 2);
	assert.deepEqual(widgetCalls[1].args[1], [
		"Plan orchestrator",
		"Goal: ship feature",
		"",
		"1. Draft plan",
		"   Meta",
		'   /chain scout "scan code"',
		'   /parallel reviewer "review code"',
		"",
		"2. Review follow-up",
		'   /chain planner "follow up"',
		"",
	]);
	assert.equal(
		ui.calls.findIndex((call: any) => call.method === "confirm") >
			ui.calls.findIndex((call: any) => call.method === "editor"),
		true,
	);
	assert.equal(pi.appended.length >= 2, true);
	assert.equal(
		fs.existsSync(path.join(sessionDir, PLAN_SESSION_SNAPSHOT_FILENAME)),
		true,
	);
});

test("/plan-orchestrator resume skips the editor and resumes immediately", async () => {
	const sessionDir = makeTempDir();
	const plan = createPlan();
	fs.mkdirSync(sessionDir, { recursive: true });
	fs.writeFileSync(
		path.join(sessionDir, PLAN_SESSION_SNAPSHOT_FILENAME),
		JSON.stringify(plan, null, 2),
		"utf8",
	);
	const pi = makePi();
	const entries = [
		{
			type: "custom",
			customType: PLAN_SESSION_CURSOR_CUSTOM_TYPE,
			data: { stepIndex: 0, commandIndex: 0 },
		},
	];
	const ui = makeUi({ editor: undefined, confirm: false, sessionDir });
	const ctx = makeCtx(sessionDir, ui, entries);
	const deps = createDependencies({
		remainder: [
			JSON.stringify({
				schemaVersion: 1,
				steps: [{ title: "Step A", commands: ['/chain scout "scan code"'] }],
			}),
		],
		execute: [
			{ ok: true, command: "", stepIndex: 0, commandIndex: 0, exitCode: 0 },
		],
	});

	registerPlanOrchestratorExtension(pi as any, deps);
	const handler = pi.commands.get("plan-orchestrator")?.handler;
	assert.ok(handler);
	if (!handler) throw new Error("Missing plan-orchestrator command");

	await handler("resume", ctx);

	assert.equal(
		ui.calls.some((call: any) => call.method === "editor"),
		false,
	);
	assert.equal(
		ui.calls.some((call: any) => call.method === "confirm"),
		false,
	);
	assert.equal(
		ui.calls.some((call: any) => call.method === "notify"),
		true,
	);
});

test("/plan-orchestrator skips refinement when editor returns empty/whitespace", async () => {
	const sessionDir = makeTempDir();
	const pi = makePi();

	let generatePlanCalls = 0;
	const deps: PlanOrchestratorDependencies = {
		planner: {
			generatePlan: async () => {
				generatePlanCalls += 1;
				return JSON.stringify(createPlan());
			},
			generateRemainder: async () =>
				JSON.stringify({ schemaVersion: 1, steps: [] }),
		},
		executeCommand: async (command, context) => ({
			ok: true,
			command,
			stepIndex: context.stepIndex,
			commandIndex: context.commandIndex,
			exitCode: 0,
		}),
	};

	const ui = makeUi({ editor: "   ", confirm: true, sessionDir });
	const ctx = makeCtx(sessionDir, ui);

	registerPlanOrchestratorExtension(pi as any, deps);
	const handler = pi.commands.get("plan-orchestrator")?.handler;
	assert.ok(handler);
	if (!handler) throw new Error("Missing plan-orchestrator command");

	await handler("build a feature", ctx);

	assert.equal(generatePlanCalls, 1);

	const widgetCalls = ui.calls.filter(
		(call: any) => call.method === "setWidget",
	);
	assert.equal(widgetCalls.length, 1);
	assert.equal(
		ui.calls.filter((call: any) => call.method === "editor").length,
		1,
	);
	assert.equal(pi.appended.length, 2);
	assert.equal(
		fs.existsSync(path.join(sessionDir, PLAN_SESSION_SNAPSHOT_FILENAME)),
		true,
	);
});

test("/plan-orchestrator notifies and returns when initial plan generation fails", async () => {
	const sessionDir = makeTempDir();
	const pi = makePi();
	const ui = makeUi({ editor: "should not run", confirm: true, sessionDir });
	const ctx = makeCtx(sessionDir, ui);

	const deps: PlanOrchestratorDependencies = {
		planner: {
			generatePlan: async () => "not json",
			generateRemainder: async () =>
				JSON.stringify({ schemaVersion: 1, steps: [] }),
		},
		executeCommand: async () => {
			throw new Error("executeCommand should not be called");
		},
	};

	registerPlanOrchestratorExtension(pi as any, deps);
	const handler = pi.commands.get("plan-orchestrator")?.handler;
	assert.ok(handler);
	if (!handler) throw new Error("Missing plan-orchestrator command");

	await handler("build a feature", ctx);

	const widgetCalls = ui.calls.filter(
		(call: any) => call.method === "setWidget",
	);
	assert.equal(widgetCalls.length, 0);

	const notifyError = ui.calls.find(
		(call: any) => call.method === "notify" && call.args[1] === "error",
	);
	assert.ok(notifyError);
	assert.match(
		String(notifyError.args[0] ?? ""),
		/Strict JSON validation failed/,
	);

	assert.equal(
		ui.calls.some((call: any) => call.method === "editor"),
		false,
	);
	assert.equal(
		ui.calls.some((call: any) => call.method === "confirm"),
		false,
	);
	assert.equal(pi.appended.length, 0);
	assert.equal(
		fs.existsSync(path.join(sessionDir, PLAN_SESSION_SNAPSHOT_FILENAME)),
		false,
	);
});

test("/plan-orchestrator notifies and returns when refinement plan generation fails", async () => {
	const sessionDir = makeTempDir();
	const pi = makePi();
	const ui = makeUi({ editor: "Make it broader", confirm: true, sessionDir });
	const ctx = makeCtx(sessionDir, ui);

	let generatePlanCalls = 0;
	const deps: PlanOrchestratorDependencies = {
		planner: {
			generatePlan: async () => {
				generatePlanCalls += 1;
				return generatePlanCalls === 1
					? JSON.stringify(createPlan())
					: "not json";
			},
			generateRemainder: async () =>
				JSON.stringify({ schemaVersion: 1, steps: [] }),
		},
		executeCommand: async () => {
			throw new Error("executeCommand should not be called");
		},
	};

	registerPlanOrchestratorExtension(pi as any, deps);
	const handler = pi.commands.get("plan-orchestrator")?.handler;
	assert.ok(handler);
	if (!handler) throw new Error("Missing plan-orchestrator command");

	await handler("build a feature", ctx);

	const widgetCalls = ui.calls.filter(
		(call: any) => call.method === "setWidget",
	);
	assert.equal(widgetCalls.length, 1);

	const notifyError = ui.calls.find(
		(call: any) => call.method === "notify" && call.args[1] === "error",
	);
	assert.ok(notifyError);
	assert.match(
		String(notifyError.args[0] ?? ""),
		/Strict JSON validation failed/,
	);

	assert.equal(
		ui.calls.some((call: any) => call.method === "confirm"),
		false,
	);
	assert.equal(pi.appended.length, 0);
	assert.equal(
		fs.existsSync(path.join(sessionDir, PLAN_SESSION_SNAPSHOT_FILENAME)),
		false,
	);
});

test("/plan-orchestrator resume notifies when snapshot file is missing", async () => {
	const sessionDir = makeTempDir();
	const pi = makePi();
	const ui = makeUi({ editor: undefined, confirm: false, sessionDir });
	const ctx = makeCtx(sessionDir, ui);
	const deps = createDependencies({});

	registerPlanOrchestratorExtension(pi as any, deps);
	const handler = pi.commands.get("plan-orchestrator")?.handler;
	assert.ok(handler);
	if (!handler) throw new Error("Missing plan-orchestrator command");

	await handler("resume", ctx);

	const notifyError = ui.calls.find(
		(call: any) => call.method === "notify" && call.args[1] === "error",
	);
	assert.ok(notifyError);
	assert.match(
		String(notifyError.args[0] ?? ""),
		/Missing active plan snapshot/,
	);

	assert.equal(
		ui.calls.some((call: any) => call.method === "editor"),
		false,
	);
	assert.equal(
		ui.calls.some((call: any) => call.method === "confirm"),
		false,
	);
	assert.equal(pi.appended.length, 0);
});

test("/plan-orchestrator resume notifies when cursor entry is missing", async () => {
	const sessionDir = makeTempDir();
	const pi = makePi();
	const ui = makeUi({ editor: undefined, confirm: false, sessionDir });
	const ctx = makeCtx(sessionDir, ui);

	const plan = createPlan();
	fs.mkdirSync(sessionDir, { recursive: true });
	fs.writeFileSync(
		path.join(sessionDir, PLAN_SESSION_SNAPSHOT_FILENAME),
		JSON.stringify(plan, null, 2),
		"utf8",
	);

	const deps = createDependencies({});

	registerPlanOrchestratorExtension(pi as any, deps);
	const handler = pi.commands.get("plan-orchestrator")?.handler;
	assert.ok(handler);
	if (!handler) throw new Error("Missing plan-orchestrator command");

	await handler("resume", ctx);

	const notifyError = ui.calls.find(
		(call: any) => call.method === "notify" && call.args[1] === "error",
	);
	assert.ok(notifyError);
	assert.match(String(notifyError.args[0] ?? ""), /Missing cursor entry/);
	assert.equal(pi.appended.length, 0);
});

test("/plan-orchestrator requires UI mode when hasUI=false", async () => {
	const sessionDir = makeTempDir();
	const pi = makePi();

	let plannerCalls = 0;
	const notifyCalls: Array<{ message: string; type?: string }> = [];
	const ui = {
		notify: (message: string, type?: string) => {
			notifyCalls.push({ message, type });
		},
	};
	const ctx = makeCtx(sessionDir, ui, [], false);

	const deps: PlanOrchestratorDependencies = {
		planner: {
			generatePlan: async () => {
				plannerCalls += 1;
				return JSON.stringify(createPlan());
			},
			generateRemainder: async () =>
				JSON.stringify({ schemaVersion: 1, steps: [] }),
		},
		executeCommand: async () => {
			throw new Error("executeCommand should not be called");
		},
	};

	registerPlanOrchestratorExtension(pi as any, deps);
	const handler = pi.commands.get("plan-orchestrator")?.handler;
	assert.ok(handler);
	if (!handler) throw new Error("Missing plan-orchestrator command");

	await handler("build a feature", ctx);

	assert.equal(plannerCalls, 0);
	assert.ok(
		notifyCalls.some(
			(c) =>
				c.type === "error" && c.message.includes("requires an interactive UI"),
		),
	);
	assert.equal(
		fs.existsSync(path.join(sessionDir, PLAN_SESSION_SNAPSHOT_FILENAME)),
		false,
	);
});
