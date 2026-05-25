import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { createSlashBridgeExecutor } from "./slash-bridge-executor.ts";
import {
	registerPlanOrchestratorExtension,
	type PlanOrchestratorPlanner,
} from "./plan-orchestrator-extension.ts";

function extractText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				part?.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function extractLatestAssistantText(
	entries: Array<{
		type: string;
		message?: { role?: string; content?: unknown };
	}>,
): string {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!entry || entry.type !== "message") continue;
		if (entry.message?.role !== "assistant") continue;
		const text = extractText(entry.message.content);
		if (text) return text;
	}
	return "";
}

function getEventBus(pi: ExtensionAPI): {
	on: (event: string, handler: (data: unknown) => void) => (() => void) | void;
	emit: (event: string, data: unknown) => void;
} {
	const candidate =
		(pi as unknown as { events?: unknown; emit?: unknown }).events ?? pi;
	if (
		candidate &&
		typeof (candidate as { on?: unknown }).on === "function" &&
		typeof (candidate as { emit?: unknown }).emit === "function"
	) {
		return candidate as {
			on: (
				event: string,
				handler: (data: unknown) => void,
			) => (() => void) | void;
			emit: (event: string, data: unknown) => void;
		};
	}
	throw new Error(
		"Plan orchestrator requires a slash-bridge event bus (on + emit)",
	);
}

function createDefaultPlanner(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): PlanOrchestratorPlanner {
	const runPlannerTurn = async (prompt: string): Promise<string> => {
		await pi.sendMessage(
			{
				customType: "plan-orchestrator-planner",
				content: prompt,
				display: false,
				details: { source: "plan-orchestrator" },
			},
			{ triggerTurn: true, deliverAs: "nextTurn" },
		);
		await ctx.waitForIdle();
		const text = extractLatestAssistantText(
			ctx.sessionManager.getEntries() as Array<{
				type: string;
				message?: { role?: string; content?: unknown };
			}>,
		);
		if (!text) {
			throw new Error("Planner returned no text output.");
		}
		return text;
	};

	return {
		generatePlan: runPlannerTurn,
		generateRemainder: runPlannerTurn,
	};
}

export default function registerPlanOrchestrator(pi: ExtensionAPI): void {
	registerPlanOrchestratorExtension(pi, {
		plannerFactory: (api, ctx) => createDefaultPlanner(api, ctx),
		executeCommand: createSlashBridgeExecutor({ events: getEventBus(pi) }),
	});
}

export {
	buildInitialPlanPrompt,
	buildRefinedPlanPrompt,
	registerPlanOrchestratorExtension,
} from "./plan-orchestrator-extension.ts";
export type {
	PlanOrchestratorDependencies,
	PlanOrchestratorPlanner,
} from "./plan-orchestrator-extension.ts";
