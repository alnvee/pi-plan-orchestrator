import { execSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import {
	generateValidPlanJson,
	generateValidRemainderJson,
} from "./planner-loop.ts";
import { compileStoredCommand } from "./command-compiler.ts";
import { runPlan, type PlanExecutionDeps, type CommandExecutionResult } from "./plan-execution.ts";
import {
	SLASH_SUBAGENT_REQUEST_EVENT,
	SLASH_SUBAGENT_RESPONSE_EVENT,
	type SlashBridgeEventBus,
} from "./slash-bridge-executor.ts";
import { getStoredCommandKind } from "./stored-command.ts";
import {
	loadPlanSessionState,
	savePlanSessionState,
	PLAN_SESSION_SNAPSHOT_FILENAME,
	type PlanSessionManagerLike,
} from "./plan-session-state.ts";
import { resumePlan } from "./resume-plan.ts";
import { validatePlanJson } from "./plan-schemas.ts";
import type { Plan, ExecutionCursor } from "./plan-schemas.ts";
import { getPlanOrchestratorConfig } from "./plan-orchestrator-config.ts";
import type { PlanOrchestratorConfig } from "./plan-orchestrator-config.ts";
import { collectResumeEvidence } from "./resume-evidence.ts";

export interface PlanOrchestratorPlanner {
	generatePlan(prompt: string): Promise<string>;
	generateRemainder(prompt: string): Promise<string>;
}

export interface PlanOrchestratorDependencies {
	planner?: PlanOrchestratorPlanner;
	plannerFactory?: (
		pi: ExtensionAPI,
		ctx: ExtensionCommandContext,
	) => PlanOrchestratorPlanner | Promise<PlanOrchestratorPlanner>;
	executeCommand: PlanExecutionDeps["executeCommand"];
	maxRetries?: number;
}

export interface PlanOrchestratorRegistration {
	register(pi: ExtensionAPI): void;
}

const PLAN_ORCHESTRATOR_COMMAND = "plan-orchestrator";
const NO_ACTIVE_CURSOR: ExecutionCursor = { stepIndex: -1, commandIndex: -1 };

const REQUIRED_INITIAL_STRICT_LINES = [
	"Return strict JSON only.",
	"Use schemaVersion 1 and include only goal and steps.",
	"Each step must have title, optional description, and commands.",
	"Every command must start with /chain or /parallel.",
	"Reject --bg; allow --fork.",
];

const REQUIRED_REFINED_STRICT_LINES = [
	"Return strict JSON only.",
	"Use schemaVersion 1 and include only goal and steps.",
];

function renderPromptTemplateBlocks(
	templateBlocks: string[],
	placeholders: Record<string, string>,
): string[] {
	const rendered: string[] = [];
	for (const rawBlock of templateBlocks) {
		const block = typeof rawBlock === "string" ? rawBlock : String(rawBlock);
		let next = block;
		for (const [key, value] of Object.entries(placeholders)) {
			next = next.split(`{{${key}}}`).join(value);
		}
		if (next.trim().length === 0) continue;
		rendered.push(next);
	}
	return rendered;
}

function ensureCanonicalStrictLines(
	blocks: string[],
	requiredLines: string[],
): string[] {
	const prompt = blocks.join("\n\n");
	let insertAt = blocks.length > 0 ? 1 : 0;
	for (const line of requiredLines) {
		if (prompt.includes(line)) continue;
		blocks.splice(insertAt, 0, line);
		insertAt += 1;
	}
	return blocks;
}

export function buildInitialPlanPromptWithConfig(
	request: string,
	config: PlanOrchestratorConfig,
	contextSummary?: string,
): string {
	const blocks = renderPromptTemplateBlocks(
		config.initialPlan.promptTemplateBlocks,
		{
			personaLine: config.initialPlan.personaLine,
			userRequestLabel: config.initialPlan.userRequestLabel,
			request,
		},
	);

	ensureCanonicalStrictLines(blocks, REQUIRED_INITIAL_STRICT_LINES);

	const trimmedContext = contextSummary?.trim();
	if (trimmedContext) {
		const lastStrictIndex = blocks.reduce((acc, block, index) => {
			if (REQUIRED_INITIAL_STRICT_LINES.some((line) => block.includes(line))) {
				return index;
			}
			return acc;
		}, -1);
		const insertAt = lastStrictIndex >= 0 ? lastStrictIndex + 1 : 1;
		blocks.splice(
			insertAt,
			0,
			`Internal codebase context for planning (use for reasoning; do not output verbatim):\n${trimmedContext}`,
		);
	}

	return blocks.join("\n\n");
}

export function buildRefinedPlanPromptWithConfig(
	request: string,
	plan: Plan,
	refinementInstructions: string,
	config: PlanOrchestratorConfig,
	contextSummary?: string,
): string {
	const blocks = renderPromptTemplateBlocks(
		config.refinedPlan.promptTemplateBlocks,
		{
			introLine: config.refinedPlan.introLine,
			currentRequestLabel: config.refinedPlan.currentRequestLabel,
			request,
			currentPlanJsonLabel: config.refinedPlan.currentPlanJsonLabel,
			currentPlanJson: JSON.stringify(plan, null, 2),
			refinementInstructionsLabel:
				config.refinedPlan.refinementInstructionsLabel,
			refinementInstructions,
		},
	);

	ensureCanonicalStrictLines(blocks, REQUIRED_REFINED_STRICT_LINES);

	const trimmedContext = contextSummary?.trim();
	if (trimmedContext) {
		const lastStrictIndex = blocks.reduce((acc, block, index) => {
			if (REQUIRED_REFINED_STRICT_LINES.some((line) => block.includes(line))) {
				return index;
			}
			return acc;
		}, -1);
		const insertAt = lastStrictIndex >= 0 ? lastStrictIndex + 1 : 1;
		blocks.splice(
			insertAt,
			0,
			`Internal codebase context for planning (use for reasoning; do not output verbatim):\n${trimmedContext}`,
		);
	}

	return blocks.join("\n\n");
}

function buildInitialPlanPrompt(
	request: string,
	contextSummary?: string,
): string {
	return buildInitialPlanPromptWithConfig(
		request,
		getPlanOrchestratorConfig(),
		contextSummary,
	);
}

function buildRefinedPlanPrompt(
	request: string,
	plan: Plan,
	refinementInstructions: string,
	contextSummary?: string,
): string {
	return buildRefinedPlanPromptWithConfig(
		request,
		plan,
		refinementInstructions,
		getPlanOrchestratorConfig(),
		contextSummary,
	);
}

function describeCount(value: number, singular: string): string {
	return value === 1 ? `${value} ${singular}` : `${value} ${singular}s`;
}

function summarizePlan(plan: Plan): {
	stepCount: number;
	commandCount: number;
	chainCommandCount: number;
	parallelCommandCount: number;
} {
	let commandCount = 0;
	let chainCommandCount = 0;
	let parallelCommandCount = 0;

	for (const step of plan.steps) {
		for (const command of step.commands) {
			commandCount += 1;
			const kind = getStoredCommandKind(command);
			if (kind === "chain") chainCommandCount += 1;
			if (kind === "parallel") parallelCommandCount += 1;
		}
	}

	return {
		stepCount: plan.steps.length,
		commandCount,
		chainCommandCount,
		parallelCommandCount,
	};
}

function isSimplePlan(
	summary: ReturnType<typeof summarizePlan>,
	config: PlanOrchestratorConfig,
): boolean {
	if (config.ui.alwaysShowRefinement) return false;
	return (
		summary.stepCount <= config.ui.simplePlanMaxSteps &&
		summary.commandCount <= config.ui.simplePlanMaxCommands
	);
}

export function renderPlanWidget(plan: Plan): string[] {
	const ui = getPlanOrchestratorConfig().ui;
	const summary = summarizePlan(plan);
	const overviewParts = [
		describeCount(summary.stepCount, "step"),
		describeCount(summary.commandCount, "command"),
	];
	if (summary.chainCommandCount > 0) {
		overviewParts.push(describeCount(summary.chainCommandCount, "chain command"));
	}
	if (summary.parallelCommandCount > 0) {
		overviewParts.push(describeCount(summary.parallelCommandCount, "parallel command"));
	}
	const lines: string[] = [
		ui.widgetHeading,
		`${ui.goalLabelPrefix}${plan.goal}`,
		`Overview: ${overviewParts.join(", ")}`,
		"",
		"Review checklist",
		"- Goal matches your request",
		"- Step order looks right",
		"- Command order matches the intended execution",
		"",
		"Steps",
		"",
	];
	plan.steps.forEach((step, index) => {
		lines.push(`${index + 1}. ${step.title}`);
		if (step.description) {
			lines.push(`${ui.descriptionIndent}Description: ${step.description}`);
		}
		lines.push(
			`${ui.descriptionIndent}Commands: ${describeCount(step.commands.length, "command")}`,
		);
		for (const command of step.commands) {
			lines.push(`${ui.commandIndent}${command}`);
		}
		lines.push("");
	});
	return lines;
}

export function renderExecutionWidget(
	plan: Plan,
	activeStep: number,
	activeCommand: number,
	results: CommandExecutionResult[],
): string[] {
	const lines: string[] = [`Executing: ${plan.goal}`, ""];
	const resultMap = new Map<string, CommandExecutionResult>();
	for (const r of results) {
		resultMap.set(`${r.stepIndex}:${r.commandIndex}`, r);
	}
	plan.steps.forEach((step, stepIndex) => {
		lines.push(`${stepIndex + 1}. ${step.title}`);
		step.commands.forEach((command, commandIndex) => {
			const key = `${stepIndex}:${commandIndex}`;
			const result = resultMap.get(key);
			const isActive = stepIndex === activeStep && commandIndex === activeCommand;
			let icon: string;
			if (isActive) {
				icon = "⟳";
			} else if (result) {
				icon = result.ok ? "✓" : "✗";
			} else {
				icon = "○";
			}
			lines.push(`  ${icon} ${command}`);
		});
		lines.push("");
	});
	return lines;
}

export function parseStepArg(
	args: string,
): { ok: true; stepNumber: number } | { ok: false; error: string } {
	const trimmed = args.trim();
	const match = /^step\s+(\S+)$/i.exec(trimmed);
	if (!match) {
		return { ok: false, error: `Invalid step argument: "${trimmed}". Expected "step <N>" where N is a positive integer.` };
	}
	const n = Number(match[1]);
	if (!Number.isInteger(n) || n < 1) {
		return { ok: false, error: `Step number must be a positive integer >= 1, got: "${match[1]}"` };
	}
	return { ok: true, stepNumber: n };
}

export function parseAndValidatePlanJson(
	text: string,
): { ok: true; plan: Plan } | { ok: false; error: string } {
	if (!text || !text.trim()) {
		return { ok: false, error: "Plan JSON is empty" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { ok: false, error: "Invalid JSON: could not parse plan text" };
	}
	const result = validatePlanJson(parsed);
	if (!result.ok) {
		return { ok: false, error: result.errors.join("; ") };
	}
	return { ok: true, plan: result.plan };
}

export function renderMergedPlanWidget(plan: Plan, cursor: ExecutionCursor): string[] {
	const lines: string[] = [`Merged plan: ${plan.goal}`, ""];
	plan.steps.forEach((step, stepIndex) => {
		let marker: string;
		if (stepIndex < cursor.stepIndex) {
			marker = "✓";
		} else if (stepIndex === cursor.stepIndex) {
			marker = "↻ rewritten";
		} else {
			marker = "→ new";
		}
		lines.push(`${marker} ${stepIndex + 1}. ${step.title}`);
		for (const command of step.commands) {
			lines.push(`  ${command}`);
		}
		lines.push("");
	});
	return lines;
}

	function renderResumeWidget(
		plan: Plan,
		cursor: ExecutionCursor,
		evidence = collectResumeEvidence([], cursor),
	): string[] {
		const ui = getPlanOrchestratorConfig().ui;
		const summary = summarizePlan(plan);
		const completedCount = evidence.completedPrefix.length;
		const failedLine = evidence.failedCommand
			? `Failed command evidence: command ${evidence.failedCommand.executionIndex + 1}`
			: "Failed command evidence: unavailable";

		return [
			"Resume review",
			`${ui.goalLabelPrefix}${plan.goal}`,
			`Cursor: step ${cursor.stepIndex + 1}, command ${cursor.commandIndex + 1}`,
			`Plan size: ${describeCount(summary.stepCount, "step")}, ${describeCount(summary.commandCount, "command")}`,
			`Completed commands: ${describeCount(completedCount, "command")}`,
			failedLine,
			"",
			"The remainder will be rewritten from the saved cursor before execution continues.",
		];
	}

function createPlanSessionManagerAdapter(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): PlanSessionManagerLike {
	return {
		getSessionDir: () => ctx.sessionManager.getSessionDir(),
		appendCustomEntry: (customType: string, data?: unknown) => {
			pi.appendEntry(customType, data);
			return randomUUID();
		},
		getEntries: () =>
			ctx.sessionManager.getEntries() as unknown as Array<{
				type: string;
				customType?: string;
				data?: unknown;
			}>,
	};
}

async function resolvePlanner(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	deps: PlanOrchestratorDependencies,
): Promise<PlanOrchestratorPlanner> {
	if (deps.planner) return deps.planner;
	if (deps.plannerFactory) return await deps.plannerFactory(pi, ctx);
	throw new Error("Plan orchestrator planner dependency is not configured");
}

function getSlashBridgeEventBus(pi: ExtensionAPI): SlashBridgeEventBus {
	const candidate =
		(pi as unknown as { events?: unknown; emit?: unknown }).events ?? pi;
	if (
		candidate &&
		typeof (candidate as { on?: unknown }).on === "function" &&
		typeof (candidate as { emit?: unknown }).emit === "function"
	) {
		return candidate as SlashBridgeEventBus;
	}
	throw new Error(
		"Plan orchestrator requires a slash-bridge event bus (on + emit)",
	);
}

function extractTextFromSlashBridgeContent(
	content: unknown,
): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		if ((part as { type?: unknown }).type !== "text") continue;
		const text = (part as { text?: unknown }).text;
		if (typeof text === "string" && text.trim().length > 0) {
			parts.push(text.trim());
		}
	}
	if (parts.length === 0) return undefined;
	return parts.join("\n").trim();
}

function resolveSlashBridgeExitCode(response: any): number {
	if (response?.isError) return 1;
	const results = response?.result?.details?.results;
	if (Array.isArray(results)) {
		for (const result of results) {
			if (typeof result?.exitCode === "number" && result.exitCode !== 0)
				return result.exitCode;
		}
	}
	return 0;
}

function resolveSlashBridgeErrorText(response: any): string {
	if (typeof response?.errorText === "string" && response.errorText.trim()) {
		return response.errorText.trim();
	}

	const results = response?.result?.details?.results;
	if (Array.isArray(results)) {
		const failedResult = results.find(
			(result) => typeof result?.exitCode === "number" && result.exitCode !== 0,
		);
		if (typeof failedResult?.error === "string" && failedResult.error) {
			return failedResult.error.trim();
		}
	}

	const text = extractTextFromSlashBridgeContent(response?.result?.content);
	if (text) return text;

	return response?.isError
		? "Slash subagent reported an error."
		: "Slash subagent returned a non-zero exit code.";
}

function buildPlanningContextBuilderCommand(request: string): string {
	// IMPORTANT: compileStoredCommand rejects any stored command string
	// containing the substring "--bg". Avoid that substring in the command
	// itself; the context summary output may include it.
	const task =
		`Gather the most relevant repository context needed to plan how to execute the user's request.\n` +
		`User request: ${request}.\n\n` +
		`You MUST:\n` +
		`- Identify the small set (5-10) of files/modules most relevant to this request.\n` +
		`- Summarize key types/interfaces/functions and how the data flows through them.\n` +
		`- Call out constraints, conventions, and likely risks/edge-cases for implementing the request.\n` +
		`- Provide short high-level "what to do next" guidance for execution agents (scout/reviewer/worker style), without writing a full plan.\n\n` +
		`Output format: plain text only (no JSON, no Markdown code fences). Prefer short bullet points. Keep under 8000 characters. Do not include any other commentary.\n` +
		`Do NOT inspect or summarize plan-orchestrator internals/schema/command-grammar; the planner prompt already enforces strict JSON and the command language.`;

	// run as a single /chain step so the result comes back as inline text
	return `/chain scout[output=false] -- ${task}`;
}

async function executeSlashBridgeForText(args: {
	pi: ExtensionAPI;
	command: string;
	timeoutMs: number;
}): Promise<string> {
	const { pi, command, timeoutMs } = args;
	const bus = getSlashBridgeEventBus(pi);
	const compiled = compileStoredCommand(command);
	if (!compiled.ok) {
		throw new Error(
			`Invalid stored command for context builder: ${compiled.errors.join("; ")}`,
		);
	}

	const requestId = randomUUID();
	let settled = false;
	const subscriptions: Array<() => void> = [];
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

	return await new Promise<string>((resolve, reject) => {
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			if (timeoutHandle) clearTimeout(timeoutHandle);
			for (const unsubscribe of subscriptions) unsubscribe();
			fn();
		};

		const unsubscribe = bus.on(
			SLASH_SUBAGENT_RESPONSE_EVENT,
			(data: unknown) => {
				if (!data || typeof data !== "object") return;
				const response = data as any;
				if (response?.requestId !== requestId) return;

				const exitCode = resolveSlashBridgeExitCode(response);
				if (exitCode !== 0) {
					const errorText = resolveSlashBridgeErrorText(response);
					finish(() => reject(new Error(errorText)));
					return;
				}

				const text = extractTextFromSlashBridgeContent(
					response?.result?.content,
				);
				if (!text) {
					finish(() =>
						reject(
							new Error(
								"Slash subagent returned empty text output for context builder.",
							),
						),
					);
					return;
				}
				finish(() => resolve(text));
			},
		);

		if (typeof unsubscribe === "function") subscriptions.push(unsubscribe);

		timeoutHandle = setTimeout(() => {
			finish(() => {
				reject(
					new Error(
						`No slash-bridge response received for context builder within ${timeoutMs}ms.`,
					),
				);
			});
		}, timeoutMs);

		bus.emit(SLASH_SUBAGENT_REQUEST_EVENT, {
			requestId,
			params: compiled.params,
		});
	});
}

async function gatherPlanningContextSummary(args: {
	pi: ExtensionAPI;
	request: string;
	config: PlanOrchestratorConfig;
	sessionDir: string;
}): Promise<string> {
	const { pi, request, config, sessionDir } = args;
	const maxChars = config.resumeEvidence.maxEvidenceChars;

	const CACHE_FILENAME = "plan-orchestrator.planning-context.json";
	const CACHE_VERSION = 2;
	const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

	const sha256Hex = (input: string): string =>
		createHash("sha256").update(input).digest("hex");

	type CodebaseFingerprint =
		| { kind: "git"; head: string; statusHash: string; diffHash: string }
		| { kind: "fallback"; signature: string };

	const computeCodebaseFingerprint = (): CodebaseFingerprint => {
		const cwd = process.cwd();

		try {
			const head = execSync("git rev-parse HEAD", {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 2000,
			}).trim();

			const status = execSync("git status --porcelain -uall", {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 2000,
			}).trim();

			// Include a cheap diff stat so cached context invalidates when
			// the working tree changes (not just HEAD/dirtiness).
			const diffShortStat = execSync("git diff --shortstat HEAD", {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 2000,
			}).trim();

			return {
				kind: "git",
				head,
				statusHash: sha256Hex(status),
				diffHash: sha256Hex(diffShortStat),
			};
		} catch {
			// Best-effort fallback: use mtimes of a few stable root files.
			const statParts: string[] = [];
			const candidates = ["package.json", "tsconfig.json"];
			for (const candidate of candidates) {
				const full = path.join(cwd, candidate);
				if (!fs.existsSync(full)) continue;
				try {
					const stat = fs.statSync(full);
					statParts.push(
						`${candidate}:${stat.mtimeMs.toFixed(0)}:${stat.size}`,
					);
				} catch {}
			}
			try {
				const cwdStat = fs.statSync(cwd);
				statParts.push(`cwd:${cwdStat.mtimeMs.toFixed(0)}:${cwdStat.size}`);
			} catch {}

			return {
				kind: "fallback",
				signature: sha256Hex(statParts.join("|")),
			};
		}
	};

	const fingerprintsMatch = (
		left: CodebaseFingerprint,
		right: CodebaseFingerprint,
	): boolean => {
		if (left.kind !== right.kind) return false;
		if (left.kind === "git" && right.kind === "git") {
			return (
				left.head === right.head &&
				left.statusHash === right.statusHash &&
				left.diffHash === right.diffHash
			);
		}
		if (left.kind === "fallback" && right.kind === "fallback") {
			return left.signature === right.signature;
		}
		return false;
	};

	let currentFingerprint: CodebaseFingerprint | undefined;
	const getCurrentFingerprint = (): CodebaseFingerprint => {
		if (currentFingerprint) return currentFingerprint;
		currentFingerprint = computeCodebaseFingerprint();
		return currentFingerprint;
	};

	const cachePath = path.join(sessionDir, CACHE_FILENAME);

	const parseFingerprint = (
		value: unknown,
	): CodebaseFingerprint | undefined => {
		if (!value || typeof value !== "object") return undefined;
		const v = value as any;
		if (v.kind === "git") {
			if (
				typeof v.head === "string" &&
				typeof v.statusHash === "string" &&
				typeof v.diffHash === "string"
			) {
				return {
					kind: "git",
					head: v.head,
					statusHash: v.statusHash,
					diffHash: v.diffHash,
				};
			}
			return undefined;
		}
		if (v.kind === "fallback") {
			if (typeof v.signature === "string") {
				return { kind: "fallback", signature: v.signature };
			}
			return undefined;
		}
		return undefined;
	};

	const readCacheEntry = (): {
		version: number;
		requestHash: string;
		maxChars: number;
		generatedAtMs: number;
		contextSummary: string;
		codebaseFingerprint: CodebaseFingerprint;
	} | null => {
		if (!fs.existsSync(cachePath)) return null;
		let raw: string;
		try {
			raw = fs.readFileSync(cachePath, "utf8");
		} catch {
			return null;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return null;
		}

		if (!parsed || typeof parsed !== "object") return null;
		const v = parsed as any;
		const fp = parseFingerprint(v.codebaseFingerprint);
		if (!fp) return null;

		if (
			typeof v.version !== "number" ||
			typeof v.requestHash !== "string" ||
			typeof v.maxChars !== "number" ||
			typeof v.generatedAtMs !== "number" ||
			typeof v.contextSummary !== "string"
		) {
			return null;
		}

		return {
			version: v.version,
			requestHash: v.requestHash,
			maxChars: v.maxChars,
			generatedAtMs: v.generatedAtMs,
			contextSummary: v.contextSummary,
			codebaseFingerprint: fp,
		};
	};

	const cached = readCacheEntry();
	if (
		cached &&
		cached.version === CACHE_VERSION &&
		cached.requestHash === sha256Hex(request) &&
		cached.maxChars === maxChars
	) {
		const ageMs = Date.now() - cached.generatedAtMs;
		if (ageMs <= CACHE_MAX_AGE_MS) {
			const fp = getCurrentFingerprint();
			if (fingerprintsMatch(cached.codebaseFingerprint, fp)) {
				if (cached.contextSummary.trim().length > 0) {
					return cached.contextSummary;
				}
			}
		}
	}

	const contextCommand = buildPlanningContextBuilderCommand(request);
	const planningContextTimeoutMs = Math.max(
		config.slashBridge.defaultTimeoutMs,
		300_000,
	);
	const raw = await executeSlashBridgeForText({
		pi,
		command: contextCommand,
		timeoutMs: planningContextTimeoutMs,
	});

	const trimmed = raw.trim();
	if (!trimmed) {
		throw new Error("Context builder returned empty context summary.");
	}

	const contextSummary =
		trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;

	const entry = {
		version: CACHE_VERSION,
		requestHash: sha256Hex(request),
		maxChars,
		generatedAtMs: Date.now(),
		contextSummary,
		codebaseFingerprint: getCurrentFingerprint(),
	};

	try {
		fs.mkdirSync(sessionDir, { recursive: true });
		fs.writeFileSync(cachePath, JSON.stringify(entry, null, 2) + "\n", "utf8");
	} catch {
		// Cache is advisory; ignore write failures.
	}

	return contextSummary;
}

async function generateAndRenderPlan(
	ctx: ExtensionCommandContext,
	planner: PlanOrchestratorPlanner,
	deps: PlanOrchestratorDependencies,
	prompt: string,
): Promise<{ ok: true; plan: Plan } | { ok: false; errors: string[] }> {
	const result = await generateValidPlanJson({
		prompt,
		generate: planner.generatePlan,
		maxRetries: deps.maxRetries,
	});
	if (!result.ok) return result;
	if (ctx.hasUI) {
		const config = getPlanOrchestratorConfig();
		ctx.ui.setWidget(config.ui.widgetKey, renderPlanWidget(result.value), {
			placement: config.ui.widgetPlacement,
		});
	}
	return { ok: true, plan: result.value };
}

async function runPlanOrchestrator(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string,
	deps: PlanOrchestratorDependencies,
): Promise<void> {
	const request = args.trim();
	const config = getPlanOrchestratorConfig();
	if (!request) {
		ctx.ui.notify(config.ui.usageHelpMessage, "error");
		return;
	}

	if (!ctx.hasUI) {
		ctx.ui.notify(config.ui.interactiveUiRequiredMessage, "error");
		return;
	}

	let contextSummary: string | undefined;
	try {
		ctx.ui.notify("Gathering repository context for planning...", "info");
		contextSummary = await gatherPlanningContextSummary({
			pi,
			request,
			config,
			sessionDir: ctx.sessionManager.getSessionDir(),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(
			`Failed to gather codebase context (continuing without it): ${message}`,
			"warning",
		);
		contextSummary = undefined;
	}

	const planner = await resolvePlanner(pi, ctx, deps);
	ctx.ui.notify("Drafting the initial plan...", "info");
	const initial = await generateAndRenderPlan(
		ctx,
		planner,
		deps,
		buildInitialPlanPrompt(request, contextSummary),
	);
	if (!initial.ok) {
		ctx.ui.notify(initial.errors.join("\n"), "error");
		return;
	}

	let plan = initial.plan;
	const planSummary = summarizePlan(plan);
	if (isSimplePlan(planSummary, config)) {
		ctx.ui.notify(
			"Simple plan detected; skipping refinement and moving to approval.",
			"info",
		);
	} else {
		ctx.ui.notify("Review the plan or add refinement instructions...", "info");
		const refinementInstructions = await ctx.ui.editor(
			config.ui.editorTitle,
			config.ui.editorPrefill,
		);
		if (
			typeof refinementInstructions === "string" &&
			refinementInstructions.trim().length > 0
		) {
			const refined = await generateAndRenderPlan(
				ctx,
				planner,
				deps,
				buildRefinedPlanPrompt(
					request,
					plan,
					refinementInstructions.trim(),
					contextSummary,
				),
			);
			if (!refined.ok) {
				ctx.ui.notify(refined.errors.join("\n"), "error");
				return;
			}
			plan = refined.plan;
		}
	}

	const wantsJsonEdit = await ctx.ui.confirm(
		"Edit plan JSON directly?",
		"Open the plan JSON in an editor to make direct changes before execution.",
	);
	if (wantsJsonEdit) {
		const jsonText = await ctx.ui.editor(
			"Edit plan JSON",
			JSON.stringify(plan, null, 2),
		);
		const parsed = parseAndValidatePlanJson(jsonText);
		if (parsed.ok) {
			plan = parsed.plan;
			ctx.ui.setWidget(
				config.ui.widgetKey,
				renderPlanWidget(plan),
				{ placement: config.ui.widgetPlacement },
			);
		} else {
			ctx.ui.notify(`JSON edit discarded: ${parsed.error}`, "warning");
		}
	}

	ctx.ui.notify("Confirm the plan before execution...", "info");
	const confirmed = await ctx.ui.confirm(
		config.ui.confirmTitle,
		`${config.ui.confirmMessage}\n\n${describeCount(
			plan.steps.length,
			"step",
		)} and ${describeCount(summarizePlan(plan).commandCount, "command")} ready to execute.`,
	);
	if (!confirmed) return;

	const session = createPlanSessionManagerAdapter(pi, ctx);
	savePlanSessionState({
		sessionManager: session,
		plan,
		cursor: NO_ACTIVE_CURSOR,
	});

	ctx.ui.notify("Executing the approved plan...", "info");
	const widgetExecuted: CommandExecutionResult[] = [];
	const execution = await runPlan(plan, NO_ACTIVE_CURSOR, {
		executeCommand: deps.executeCommand,
		onCommandStart: (cmdCtx) => {
			if (ctx.hasUI) {
				ctx.ui.setWidget(
					config.ui.widgetKey,
					renderExecutionWidget(plan, cmdCtx.stepIndex, cmdCtx.commandIndex, widgetExecuted),
					{ placement: config.ui.widgetPlacement },
				);
			}
		},
		onCommandComplete: (result) => {
			widgetExecuted.push(result);
			if (ctx.hasUI) {
				ctx.ui.setWidget(
					config.ui.widgetKey,
					renderExecutionWidget(plan, -1, -1, widgetExecuted),
					{ placement: config.ui.widgetPlacement },
				);
			}
		},
	});

	savePlanSessionState({
		sessionManager: session,
		plan,
		cursor: execution.cursor,
	});

	if (!execution.ok) {
		ctx.ui.notify(
			`Execution failed at step ${execution.cursor.stepIndex}, command ${execution.cursor.commandIndex}: ${execution.failed.error}`,
			"error",
		);
		return;
	}

	ctx.ui.notify(config.ui.planCompletedNotification, "info");
}

async function runPlanOrchestratorResume(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	deps: PlanOrchestratorDependencies,
): Promise<void> {
	const config = getPlanOrchestratorConfig();
	const planner = await resolvePlanner(pi, ctx, deps);
	const session = createPlanSessionManagerAdapter(pi, ctx);
	const loaded = loadPlanSessionState({ sessionManager: session });
	let loadedEvidence;
	if (loaded.ok && ctx.hasUI) {
		loadedEvidence = collectResumeEvidence(session.getEntries(), loaded.cursor);
		ctx.ui.setWidget(
			config.ui.widgetKey,
			renderResumeWidget(loaded.plan, loaded.cursor, loadedEvidence),
			{
			placement: config.ui.widgetPlacement,
			},
		);
	}
	if (loaded.ok) {
		const evidence = loadedEvidence ?? collectResumeEvidence(session.getEntries(), loaded.cursor);
		ctx.ui.notify(
			`Resume review: ${describeCount(evidence.completedPrefix.length, "completed command")}, ${evidence.failedCommand ? `rewriting from failed command ${evidence.failedCommand.executionIndex + 1}` : "no failed command evidence"}.`,
			"info",
		);
	}
	const result = await resumePlan({
		loadPlanSessionState: () => loaded,
		getEntries: () => session.getEntries(),
		generateValidRemainderJson,
		generateRemainder: planner.generateRemainder,
		executeCommand: deps.executeCommand,
		maxRetries: deps.maxRetries,
		onMergedPlanReady: async (mergedPlan, cursor) => {
			if (ctx.hasUI) {
				ctx.ui.setWidget(
					config.ui.widgetKey,
					renderMergedPlanWidget(mergedPlan, cursor),
					{ placement: config.ui.widgetPlacement },
				);
				const approved = await ctx.ui.confirm(
					"Resume with rewritten plan?",
					"The plan has been rewritten from the cursor. Continue execution?",
				);
				if (!approved) return false;
			}
			return true;
		},
	});

	if (!result.ok) {
		ctx.ui.notify(result.errors.join("\n"), "error");
		return;
	}

	ctx.ui.notify("Resuming the saved plan...", "info");
	savePlanSessionState({
		sessionManager: session,
		plan: result.mergedPlan,
		cursor: result.execution.cursor,
	});

	if (!result.execution.ok) {
		ctx.ui.notify(
			`Resume failed at step ${result.execution.cursor.stepIndex}, command ${result.execution.cursor.commandIndex}: ${result.execution.failed.error}`,
			"error",
		);
		return;
	}

	ctx.ui.notify(config.ui.resumeCompletedNotification, "info");
}

async function runPlanOrchestratorStep(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	stepNumber: number,
	deps: PlanOrchestratorDependencies,
): Promise<void> {
	const session = createPlanSessionManagerAdapter(pi, ctx);
	const snapshotPath = path.join(
		session.getSessionDir(),
		PLAN_SESSION_SNAPSHOT_FILENAME,
	);
	if (!fs.existsSync(snapshotPath)) {
		ctx.ui.notify("No active plan found. Run /plan-orchestrator first.", "error");
		return;
	}
	let planRaw: unknown;
	try {
		planRaw = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
	} catch {
		ctx.ui.notify("Failed to read plan snapshot.", "error");
		return;
	}
	const planCheck = validatePlanJson(planRaw);
	if (!planCheck.ok) {
		ctx.ui.notify(`Invalid plan snapshot: ${planCheck.errors.join("; ")}`, "error");
		return;
	}
	const plan = planCheck.plan;
	const stepIndex = stepNumber - 1;
	if (stepIndex >= plan.steps.length) {
		ctx.ui.notify(
			`Step ${stepNumber} does not exist. Plan has ${plan.steps.length} step(s).`,
			"error",
		);
		return;
	}
	const skipStepIndices = new Set(
		plan.steps.map((_, i) => i).filter((i) => i !== stepIndex),
	);

	ctx.ui.notify(`Running step ${stepNumber}: ${plan.steps[stepIndex]?.title}`, "info");
	const execution = await runPlan(plan, NO_ACTIVE_CURSOR, {
		executeCommand: deps.executeCommand,
		skipStepIndices,
	});
	if (!execution.ok) {
		ctx.ui.notify(
			`Step ${stepNumber} failed at command ${execution.cursor.commandIndex + 1}: ${execution.failed.error}`,
			"error",
		);
		return;
	}
	ctx.ui.notify(`Step ${stepNumber} completed.`, "info");
}

export function registerPlanOrchestratorExtension(
	pi: ExtensionAPI,
	deps: PlanOrchestratorDependencies,
): void {
	pi.registerCommand(PLAN_ORCHESTRATOR_COMMAND, {
		description:
			"Generate and (after confirmation) execute a strict JSON multi-step plan using pi-subagents /chain and /parallel. Usage: /plan-orchestrator <request>. Resume after failure with /plan-orchestrator resume. Run a single step with /plan-orchestrator step <N>.",
		getArgumentCompletions: (argumentPrefix: string) => {
			const prefix = argumentPrefix.trimStart();
			if (prefix.length === 0 || "resume".startsWith(prefix)) {
				return [
					{
						value: "resume",
						label: "resume",
						description: "Resume the last failed plan run",
					},
				];
			}
			return null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed === "resume") {
				await runPlanOrchestratorResume(pi, ctx, deps);
				return;
			}
			if (trimmed === "history") {
				const session = createPlanSessionManagerAdapter(pi, ctx);
				const history = loadPlanHistory(session.getSessionDir());
				ctx.ui.setWidget(
					"plan-orchestrator:history",
					renderPlanHistoryWidget(history),
					{ placement: "top" },
				);
				return;
			}
			const stepArg = parseStepArg(trimmed);
			if (stepArg.ok) {
				await runPlanOrchestratorStep(pi, ctx, stepArg.stepNumber, deps);
				return;
			}
			await runPlanOrchestrator(pi, ctx, trimmed, deps);
		},
	});
}

export { buildInitialPlanPrompt, buildRefinedPlanPrompt };

const PLAN_HISTORY_FILENAME = "plan-orchestrator.history.json";
const PLAN_HISTORY_MAX = 5;

export function savePlanToHistory(sessionDir: string, plan: Plan): void {
	const historyPath = path.join(sessionDir, PLAN_HISTORY_FILENAME);
	let existing: Plan[] = [];
	if (fs.existsSync(historyPath)) {
		try {
			existing = JSON.parse(fs.readFileSync(historyPath, "utf8")) as Plan[];
		} catch {
			existing = [];
		}
	}
	existing.push(plan);
	fs.mkdirSync(sessionDir, { recursive: true });
	fs.writeFileSync(historyPath, JSON.stringify(existing, null, 2), "utf8");
}

export function loadPlanHistory(sessionDir: string): Plan[] {
	const historyPath = path.join(sessionDir, PLAN_HISTORY_FILENAME);
	if (!fs.existsSync(historyPath)) return [];
	try {
		const all = JSON.parse(fs.readFileSync(historyPath, "utf8")) as Plan[];
		return all.slice(-PLAN_HISTORY_MAX);
	} catch {
		return [];
	}
}

export function renderPlanHistoryWidget(plans: Plan[]): string[] {
	if (plans.length === 0) {
		return ["No plan history found."];
	}
	const lines: string[] = ["**Plan History** (most recent last)"];
	plans.forEach((p, i) => {
		lines.push(`${i + 1}. ${p.goal} (${p.steps.length} step(s))`);
	});
	return lines;
}
