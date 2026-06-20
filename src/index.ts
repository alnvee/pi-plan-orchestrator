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
	if (typeof content === "string") return content.trim();
	// Some runtimes may store assistant text directly as { text: "..." }.
	if (content && typeof content === "object" && !Array.isArray(content)) {
		const maybeText = (content as any).text;
		if (typeof maybeText === "string") return maybeText.trim();
	}
	if (!Array.isArray(content)) return "";

	const parts = content
		.map((part) => {
			if (!part || typeof part !== "object") return null;
			if ((part as any).type !== "text") return null;
			if (typeof (part as any).text === "string")
				return (part as any).text as string;
			if (typeof (part as any).content === "string")
				return (part as any).content as string;
			return null;
		})
		.filter((x): x is string => typeof x === "string" && x.trim().length > 0);

	return parts.join("\n").trim();
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
		// Planner generation should not require tools (and should not go hunting
		// through the codebase for how this extension is wired). We disable all
		// tool calls for the planner turn and rely on the prompt templates.
		const toolApi = pi as unknown as {
			getActiveTools?: () => string[];
			setActiveTools?: (names: string[]) => void;
		};

		const canControlTools =
			typeof toolApi.getActiveTools === "function" &&
			typeof toolApi.setActiveTools === "function";

		const prevTools = canControlTools ? toolApi.getActiveTools!() : [];
		try {
			if (canControlTools) {
				toolApi.setActiveTools!([]);
			}
			await pi.sendMessage(
				{
					customType: "plan-orchestrator-planner",
					content: prompt,
					display: false,
					details: { source: "plan-orchestrator" },
				},
				// `deliverAs: "nextTurn"` queues this custom message without actually
				// triggering a new LLM turn when the session is currently idle.
				// For planner generation we want immediate output, so rely on
				// `triggerTurn: true` alone.
				{ triggerTurn: true },
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
		} finally {
			if (canControlTools) {
				toolApi.setActiveTools!(prevTools);
			}
		}
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
