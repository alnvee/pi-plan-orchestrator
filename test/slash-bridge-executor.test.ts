import assert from "node:assert/strict";
import { test } from "node:test";

import {
	createSlashBridgeExecutor,
	SLASH_SUBAGENT_REQUEST_EVENT,
	SLASH_SUBAGENT_RESPONSE_EVENT,
	SLASH_SUBAGENT_STARTED_EVENT,
	SLASH_SUBAGENT_UPDATE_EVENT,
	type SlashBridgeEventBus,
} from "../src/slash-bridge-executor.ts";

function createFakeBus(): SlashBridgeEventBus & {
	requests: unknown[];
} {
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	const requests: unknown[] = [];

	return {
		requests,
		on(event, handler) {
			const handlers = listeners.get(event) ?? [];
			handlers.push(handler);
			listeners.set(event, handlers);
			return () => {
				const next = (listeners.get(event) ?? []).filter(
					(entry) => entry !== handler,
				);
				listeners.set(event, next);
			};
		},
		emit(event, data) {
			if (event === SLASH_SUBAGENT_REQUEST_EVENT) {
				requests.push(data);
			}
			for (const handler of listeners.get(event) ?? []) {
				handler(data);
			}
		},
	};
}

test("createSlashBridgeExecutor matches request/response by requestId", async () => {
	const bus = createFakeBus();
	const executor = createSlashBridgeExecutor({
		events: bus,
		requestIdFactory: () => "req-1",
		connectionTimeoutMs: 50,
	});

	bus.on(SLASH_SUBAGENT_REQUEST_EVENT, () => {
		bus.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
			requestId: "req-wrong",
			isError: false,
			result: {
				content: [{ type: "text", text: "wrong request" }],
				details: { results: [{ agent: "scout", exitCode: 0 }] },
			},
		});
		bus.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
			requestId: "req-1",
			isError: false,
			result: {
				content: [{ type: "text", text: "done" }],
				details: { results: [{ agent: "scout", exitCode: 0 }] },
			},
		});
	});

	const result = await executor(
		'/chain scout "scan code" -> planner "analyze auth" --fork',
		{
			stepIndex: 1,
			commandIndex: 2,
		},
	);

	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("Expected slash bridge execution to succeed");
	assert.equal(result.exitCode, 0);
	assert.equal(result.requestId, "req-1");
	assert.equal(result.stepIndex, 1);
	assert.equal(result.commandIndex, 2);
	assert.equal(bus.requests.length, 1);
	assert.deepEqual(bus.requests[0], {
		requestId: "req-1",
		params: {
			chain: [
				{ agent: "scout", task: "scan code" },
				{ agent: "planner", task: "analyze auth" },
			],
			task: "scan code",
			clarify: false,
			agentScope: "both",
			context: "fork",
		},
	});
});

test("createSlashBridgeExecutor treats child failures as command failures", async () => {
	const bus = createFakeBus();
	const executor = createSlashBridgeExecutor({
		events: bus,
		requestIdFactory: () => "req-2",
		connectionTimeoutMs: 50,
	});

	bus.on(SLASH_SUBAGENT_REQUEST_EVENT, () => {
		bus.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
			requestId: "req-2",
			isError: false,
			result: {
				content: [{ type: "text", text: "one child failed" }],
				details: {
					results: [
						{ agent: "scout", exitCode: 0 },
						{ agent: "reviewer", exitCode: 1, error: "reviewer failed" },
					],
				},
			},
		});
	});

	const result = await executor(
		"/parallel scout reviewer -- check for security issues",
		{
			stepIndex: 0,
			commandIndex: 0,
		},
	);

	assert.equal(result.ok, false);
	if (result.ok) throw new Error("Expected slash bridge execution to fail");
	assert.equal(result.exitCode, 1);
	assert.equal(result.requestId, "req-2");
	assert.match(result.error, /reviewer failed/);
});

test("createSlashBridgeExecutor surfaces bridge-level error text", async () => {
	const bus = createFakeBus();
	const executor = createSlashBridgeExecutor({
		events: bus,
		requestIdFactory: () => "req-3",
		connectionTimeoutMs: 50,
	});

	bus.on(SLASH_SUBAGENT_REQUEST_EVENT, () => {
		bus.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
			requestId: "req-3",
			isError: true,
			errorText: "No active extension context.",
			result: {
				content: [{ type: "text", text: "No active extension context." }],
				details: {
					results: [
						{
							agent: "scout",
							exitCode: 1,
							error: "No active extension context.",
						},
					],
				},
			},
		});
	});

	const result = await executor("/chain scout -- scan code", {
		stepIndex: 0,
		commandIndex: 0,
	});

	assert.equal(result.ok, false);
	if (result.ok) throw new Error("Expected slash bridge execution to fail");
	assert.equal(result.exitCode, 1);
	assert.equal(result.requestId, "req-3");
	assert.match(result.error, /No active extension context/);
});

test("createSlashBridgeExecutor ignores updates for other requestIds", async () => {
	const bus = createFakeBus();
	const seenUpdates: unknown[] = [];
	const executor = createSlashBridgeExecutor({
		events: bus,
		requestIdFactory: () => "req-4",
		connectionTimeoutMs: 50,
		onUpdate: (data) => {
			seenUpdates.push(data);
		},
	});

	bus.on(SLASH_SUBAGENT_REQUEST_EVENT, () => {
		bus.emit(SLASH_SUBAGENT_UPDATE_EVENT, {
			requestId: "req-other",
			progress: [],
		});
		bus.emit(SLASH_SUBAGENT_UPDATE_EVENT, { requestId: "req-4", progress: [] });
		bus.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
			requestId: "req-4",
			isError: false,
			result: {
				content: [{ type: "text", text: "done" }],
				details: { results: [{ agent: "scout", exitCode: 0 }] },
			},
		});
	});

	const result = await executor("/chain scout -- scan code", {
		stepIndex: 0,
		commandIndex: 0,
	});

	assert.equal(result.ok, true);
	assert.equal(seenUpdates.length, 1);
	assert.deepEqual(seenUpdates[0], { requestId: "req-4", progress: [] });
});

test("createSlashBridgeExecutor fails when an update reports idle or interruption", async () => {
	const bus = createFakeBus();
	const executor = createSlashBridgeExecutor({
		events: bus,
		requestIdFactory: () => "req-idle",
		connectionTimeoutMs: 100,
	});

	bus.on(SLASH_SUBAGENT_REQUEST_EVENT, () => {
		bus.emit(SLASH_SUBAGENT_UPDATE_EVENT, {
			requestId: "req-idle",
			progress: {
				status: "needs_attention",
				message: "reviewer needs attention (no observed activity for 60s)",
			},
		});
	});

	const result = await executor("/chain reviewer -- review code", {
		stepIndex: 2,
		commandIndex: 0,
	});

	assert.equal(result.ok, false);
	if (result.ok) throw new Error("Expected slash bridge execution to fail");
	assert.match(result.error, /needs attention/i);
	assert.match(result.error, /idle|interruption/i);
});

test("createSlashBridgeExecutor fails with timeout details when no response is received", async () => {
	const bus = createFakeBus();
	const executor = createSlashBridgeExecutor({
		events: bus,
		requestIdFactory: () => "req-timeout",
		connectionTimeoutMs: 50,
	});

	const result = await executor(
		'/chain scout "scan code" -> planner "analyze auth"',
		{
			stepIndex: 0,
			commandIndex: 0,
		},
	);

	assert.equal(result.ok, false);
	if (result.ok) throw new Error("Expected slash bridge execution to fail");
	assert.equal(result.exitCode, 1);
	assert.equal(result.requestId, "req-timeout");
	assert.match(result.error, /No slash subagent bridge responded/);
	assert.match(result.error, /50ms/);
	assert.match(result.error, /req-timeout/);
	assert.equal(bus.requests.length, 1);
	assert.equal((bus.requests[0] as any)?.requestId, "req-timeout");
});

test("createSlashBridgeExecutor waits indefinitely once started event fires", async () => {
	const bus = createFakeBus();
	const executor = createSlashBridgeExecutor({
		events: bus,
		requestIdFactory: () => "req-slow",
		connectionTimeoutMs: 20,
	});

	bus.on(SLASH_SUBAGENT_REQUEST_EVENT, () => {
		// started fires immediately (within the 20ms connection window)
		bus.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId: "req-slow" });
		// response arrives at 60ms — well after connectionTimeoutMs would have fired
		setTimeout(() => {
			bus.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId: "req-slow",
				isError: false,
				result: {
					content: [{ type: "text", text: "done after long run" }],
					details: { results: [{ agent: "scout", exitCode: 0 }] },
				},
			});
		}, 60);
	});

	const result = await executor('/chain scout -- scan code', {
		stepIndex: 0,
		commandIndex: 0,
	});

	assert.equal(result.ok, true, "started event must prevent the connection timeout from firing");
	if (!result.ok) throw new Error("Expected success after started event");
	assert.equal(result.exitCode, 0);
	assert.equal(result.requestId, "req-slow");
});

test("createSlashBridgeExecutor fails immediately when context signal is already aborted", async () => {
	const bus = createFakeBus();
	const executor = createSlashBridgeExecutor({
		events: bus,
		requestIdFactory: () => "req-pre-aborted",
		connectionTimeoutMs: 50,
	});
	const controller = new AbortController();
	controller.abort();

	const result = await executor("/chain scout -- scan code", {
		stepIndex: 0,
		commandIndex: 0,
		signal: controller.signal,
	});

	assert.equal(result.ok, false);
	if (result.ok) throw new Error("Expected failure");
	assert.match(result.error, /aborted/i);
	assert.equal(bus.requests.length, 0, "no request should be emitted when already aborted");
});

test("createSlashBridgeExecutor aborts a pending execution when signal fires", async () => {
	const bus = createFakeBus();
	const executor = createSlashBridgeExecutor({
		events: bus,
		requestIdFactory: () => "req-live-abort",
		connectionTimeoutMs: 500,
	});
	const controller = new AbortController();

	bus.on(SLASH_SUBAGENT_REQUEST_EVENT, () => {
		// Fire started so the connection timeout is cleared, then abort before response
		bus.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId: "req-live-abort" });
		setTimeout(() => controller.abort(), 20);
	});

	const result = await executor("/chain scout -- scan code", {
		stepIndex: 0,
		commandIndex: 0,
		signal: controller.signal,
	});

	assert.equal(result.ok, false);
	if (result.ok) throw new Error("Expected failure");
	assert.match(result.error, /aborted/i);
	assert.equal(result.requestId, "req-live-abort");
});
