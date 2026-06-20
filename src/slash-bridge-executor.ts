import { randomUUID } from "node:crypto";

import { compileStoredCommand } from "./command-compiler.ts";
import type {
	CommandExecutionContext,
	CommandExecutionFailure,
	CommandExecutionResult,
	CommandExecutionSuccess,
} from "./plan-execution.ts";

import { getPlanOrchestratorConfig } from "./plan-orchestrator-config.ts";

export const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
export const SLASH_SUBAGENT_STARTED_EVENT = "subagent:slash:started";
export const SLASH_SUBAGENT_RESPONSE_EVENT = "subagent:slash:response";
export const SLASH_SUBAGENT_UPDATE_EVENT = "subagent:slash:update";

export interface SlashBridgeEventBus {
	on(event: string, handler: (data: unknown) => void): (() => void) | void;
	emit(event: string, data: unknown): void;
}

interface SlashBridgeEnvelopeLike {
	requestId: string;
}

interface SlashBridgeResponseLike extends SlashBridgeEnvelopeLike {
	isError?: boolean;
	errorText?: string;
	result?: {
		content?: unknown;
		details?: {
			results?: Array<{
				agent?: string;
				exitCode?: number;
				error?: string;
			}>;
		};
	};
}

interface SlashBridgeUpdateLike extends SlashBridgeEnvelopeLike {
	progress?: unknown;
}

export interface SlashBridgeExecutorOptions {
	events: SlashBridgeEventBus;
	requestIdFactory?: () => string;
	connectionTimeoutMs?: number;
	onUpdate?: (data: unknown) => void;
}

function firstTextContent(content: unknown): string | undefined {
	if (typeof content === "string") {
		const text = content.trim();
		return text.length > 0 ? text : undefined;
	}

	if (content && typeof content === "object" && !Array.isArray(content)) {
		const candidate = content as { text?: unknown; content?: unknown };
		if (typeof candidate.text === "string" && candidate.text.trim().length > 0) {
			return candidate.text.trim();
		}
		if (typeof candidate.content === "string" && candidate.content.trim().length > 0) {
			return candidate.content.trim();
		}
	}

	if (!Array.isArray(content)) return undefined;

	for (const part of content) {
		if (!part || typeof part !== "object") {
			if (typeof part === "string" && part.trim().length > 0) return part.trim();
			continue;
		}
		const candidate = part as { type?: string; text?: unknown; content?: unknown };
		if (candidate.type !== undefined && candidate.type !== "text") continue;
		if (typeof candidate.text === "string" && candidate.text.trim().length > 0) {
			return candidate.text.trim();
		}
		if (typeof candidate.content === "string" && candidate.content.trim().length > 0) {
			return candidate.content.trim();
		}
	}

	return undefined;
}

function isSlashBridgeResponseLike(
	value: unknown,
): value is SlashBridgeResponseLike {
	if (!value || typeof value !== "object") return false;
	const response = value as { requestId?: unknown; result?: unknown };
	if (typeof response.requestId !== "string" || response.requestId.length === 0)
		return false;
	if (
		response.result !== undefined &&
		(typeof response.result !== "object" || response.result === null)
	)
		return false;
	return true;
}

function resolveExitCode(response: SlashBridgeResponseLike): number {
	if (response.isError) return 1;
	const results = response.result?.details?.results;
	if (Array.isArray(results)) {
		for (const result of results) {
			if (typeof result.exitCode === "number" && result.exitCode !== 0)
				return result.exitCode;
		}
	}
	return 0;
}

function resolveErrorText(response: SlashBridgeResponseLike): string {
	if (
		typeof response.errorText === "string" &&
		response.errorText.trim().length > 0
	) {
		return response.errorText.trim();
	}

	const results = response.result?.details?.results;
	if (Array.isArray(results)) {
		const failedResult = results.find(
			(result) => typeof result.exitCode === "number" && result.exitCode !== 0,
		);
		if (failedResult?.error) return failedResult.error;
	}

	const text = firstTextContent(response.result?.content);
	if (text) return text;

	return response.isError
		? "Slash subagent reported an error."
		: "Slash subagent returned a non-zero exit code.";
}

function failureResult(
	command: string,
	context: CommandExecutionContext,
	error: string,
	requestId?: string,
	exitCode = 1,
): CommandExecutionFailure {
	return {
		ok: false,
		command,
		stepIndex: context.stepIndex,
		commandIndex: context.commandIndex,
		exitCode,
		error,
		...(requestId ? { requestId } : {}),
	};
}

function successResult(
	command: string,
	context: CommandExecutionContext,
	requestId: string,
): CommandExecutionSuccess {
	return {
		ok: true,
		command,
		stepIndex: context.stepIndex,
		commandIndex: context.commandIndex,
		exitCode: 0,
		requestId,
	};
}

function subscribe(
	events: SlashBridgeEventBus,
	event: string,
	handler: (data: unknown) => void,
	subscriptions: Array<() => void>,
): void {
	const unsubscribe = events.on(event, handler);
	if (typeof unsubscribe === "function") subscriptions.push(unsubscribe);
}

export function createSlashBridgeExecutor(options: SlashBridgeExecutorOptions) {
	return async (
		command: string,
		context: CommandExecutionContext,
	): Promise<CommandExecutionResult> => {
		const compiled = compileStoredCommand(command);
		if (!compiled.ok) {
			return failureResult(command, context, compiled.errors.join("; "));
		}

		const signal = context.signal;
		if (signal?.aborted) {
			return failureResult(command, context, "Execution was aborted.");
		}

		const requestId = options.requestIdFactory?.() ?? randomUUID();
		const connectionTimeoutMs =
			options.connectionTimeoutMs ??
			getPlanOrchestratorConfig().slashBridge.connectionTimeoutMs;
		const subscriptions: Array<() => void> = [];
		let settled = false;
		let connectionTimeoutHandle: ReturnType<typeof setTimeout> | undefined;

		return await new Promise<CommandExecutionResult>((resolve) => {
			const finish = (result: CommandExecutionResult) => {
				if (settled) return;
				settled = true;
				if (connectionTimeoutHandle) clearTimeout(connectionTimeoutHandle);
				for (const unsubscribe of subscriptions) unsubscribe();
				resolve(result);
			};

			if (signal) {
				const onAbort = () => {
					finish(failureResult(command, context, "Execution was aborted.", requestId));
				};
				signal.addEventListener("abort", onAbort, { once: true });
				subscriptions.push(() => signal.removeEventListener("abort", onAbort));
			}

			subscribe(
				options.events,
				SLASH_SUBAGENT_STARTED_EVENT,
				(data) => {
					if (!data || typeof data !== "object") return;
					const envelope = data as Partial<SlashBridgeEnvelopeLike>;
					if (envelope.requestId !== requestId) return;
					// Bridge confirmed the subagent is running — clear connection timeout
					if (connectionTimeoutHandle) {
						clearTimeout(connectionTimeoutHandle);
						connectionTimeoutHandle = undefined;
					}
				},
				subscriptions,
			);

			subscribe(
				options.events,
				SLASH_SUBAGENT_RESPONSE_EVENT,
				(data) => {
					if (!isSlashBridgeResponseLike(data)) return;
					if (data.requestId !== requestId) return;

					const exitCode = resolveExitCode(data);
					if (exitCode !== 0) {
						finish(
							failureResult(
								command,
								context,
								resolveErrorText(data),
								requestId,
								exitCode,
							),
						);
						return;
					}

					finish(successResult(command, context, requestId));
				},
				subscriptions,
			);

			subscribe(
				options.events,
				SLASH_SUBAGENT_UPDATE_EVENT,
				(data) => {
					if (!data || typeof data !== "object") return;
					const update = data as Partial<SlashBridgeUpdateLike>;
					if (update.requestId !== requestId) return;
					if (typeof options.onUpdate === "function") options.onUpdate(data);
				},
				subscriptions,
			);

			connectionTimeoutHandle = setTimeout(() => {
				finish(
					failureResult(
						command,
						context,
						`No slash subagent bridge responded within ${connectionTimeoutMs}ms (requestId: ${requestId}).`,
						requestId,
					),
				);
			}, connectionTimeoutMs);

			options.events.emit(SLASH_SUBAGENT_REQUEST_EVENT, {
				requestId,
				params: compiled.params,
			});
		});
	};
}
