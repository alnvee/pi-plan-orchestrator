import {
	getStoredCommandKind,
	type StoredCommandKind,
} from "./stored-command.ts";

export type CompiledStep = {
	agent: string;
	task?: string;
	output?: string | false;
	outputMode?: "inline" | "file-only";
	reads?: string[] | false;
	progress?: boolean;
	skill?: string[] | false;
	model?: string;
};

export type CompiledChainParams = {
	chain: CompiledStep[];
	task: string;
	clarify: false;
	agentScope: "both";
	context?: "fork";
};

export type CompiledParallelParams = {
	tasks: CompiledStep[];
	clarify: false;
	agentScope: "both";
	context?: "fork";
};

export type CompileStoredCommandResult =
	| { ok: true; kind: "chain"; params: CompiledChainParams }
	| { ok: true; kind: "parallel"; params: CompiledParallelParams }
	| { ok: false; errors: string[] };

type InlineConfig = {
	output?: string | false;
	outputMode?: "inline" | "file-only";
	reads?: string[] | false;
	model?: string;
	skill?: string[] | false;
	progress?: boolean;
};

type ParsedStep = {
	name: string;
	config: InlineConfig;
	task?: string;
};

function parseInlineConfig(raw: string): InlineConfig {
	const config: InlineConfig = {};
	for (const part of raw.split(",")) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) {
			if (trimmed === "progress") config.progress = true;
			continue;
		}
		const key = trimmed.slice(0, eq).trim();
		const val = trimmed.slice(eq + 1).trim();
		switch (key) {
			case "output":
				config.output = val === "false" ? false : val;
				break;
			case "outputMode":
				if (val === "inline" || val === "file-only") config.outputMode = val;
				break;
			case "reads":
				config.reads = val === "false" ? false : val.split("+").filter(Boolean);
				break;
			case "model":
				config.model = val || undefined;
				break;
			case "skill":
			case "skills":
				config.skill = val === "false" ? false : val.split("+").filter(Boolean);
				break;
			case "progress":
				config.progress = val !== "false";
				break;
		}
	}
	return config;
}

function parseAgentToken(
	token: string,
):
	| { ok: true; name: string; config: InlineConfig }
	| { ok: false; error: string } {
	const trimmed = token.trim();
	if (!trimmed) return { ok: false, error: "Missing agent name" };
	const bracket = trimmed.indexOf("[");
	if (bracket === -1) return { ok: true, name: trimmed, config: {} };
	const end = trimmed.lastIndexOf("]");
	return {
		ok: true,
		name: trimmed.slice(0, bracket),
		config: parseInlineConfig(
			trimmed.slice(bracket + 1, end !== -1 ? end : undefined),
		),
	};
}

function stripTrailingForkFlag(input: string): { body: string; fork: boolean } {
	let body = input.trim();
	let fork = false;

	while (body.length > 0) {
		if (body === "--fork") {
			fork = true;
			body = "";
			break;
		}
		if (body.endsWith(" --fork")) {
			fork = true;
			body = body.slice(0, -7).trimEnd();
			continue;
		}
		break;
	}

	return { body, fork };
}

function parseStoredCommandArgs(
	kind: StoredCommandKind,
	input: string,
):
	| { ok: true; steps: ParsedStep[]; sharedTask: string }
	| { ok: false; error: string } {
	const usage = `Usage: /${kind} agent1 "task1" -> agent2 "task2"`;
	const trimmed = input.trim();
	if (!trimmed) return { ok: false, error: usage };

	const steps: ParsedStep[] = [];
	let sharedTask = "";
	let perStep = false;

	if (trimmed.includes(" -> ")) {
		perStep = true;
		for (const segment of trimmed.split(" -> ")) {
			const stepText = segment.trim();
			if (!stepText) continue;

			let agentPart: string;
			let task: string | undefined;
			const quotedMatch = stepText.match(
				/^(\S+(?:\[[^\]]*\])?)\s+(?:"([^"]*)"|'([^']*)')$/,
			);
			if (quotedMatch) {
				agentPart = quotedMatch[1]!;
				task = (quotedMatch[2] ?? quotedMatch[3]) || undefined;
			} else {
				const dashIdx = stepText.indexOf(" -- ");
				if (dashIdx !== -1) {
					agentPart = stepText.slice(0, dashIdx).trim();
					task = stepText.slice(dashIdx + 4).trim() || undefined;
				} else {
					agentPart = stepText;
				}
			}

			const parsed = parseAgentToken(agentPart);
			if (!parsed.ok) return { ok: false, error: parsed.error };
			steps.push({ name: parsed.name, config: parsed.config, task });
		}
		sharedTask = steps.find((step) => step.task)?.task ?? "";
	} else {
		const delimiterIndex = trimmed.indexOf(" -- ");
		if (delimiterIndex === -1) return { ok: false, error: usage };
		const agentsPart = trimmed.slice(0, delimiterIndex).trim();
		sharedTask = trimmed.slice(delimiterIndex + 4).trim();
		if (!agentsPart || !sharedTask) return { ok: false, error: usage };

		for (const part of agentsPart.split(/\s+/).filter(Boolean)) {
			const parsed = parseAgentToken(part);
			if (!parsed.ok) return { ok: false, error: parsed.error };
			steps.push({ name: parsed.name, config: parsed.config });
		}
	}

	if (steps.length === 0) return { ok: false, error: usage };
	if (kind === "chain" && !steps[0]?.task && (perStep || !sharedTask)) {
		return {
			ok: false,
			error: `First step must have a task: /chain agent "task" -> agent2`,
		};
	}
	if (kind === "parallel" && !steps.some((step) => step.task) && !sharedTask) {
		return { ok: false, error: "At least one step must have a task" };
	}

	return { ok: true, steps, sharedTask };
}

function buildStep(
	step: ParsedStep,
	fallbackTask: string | undefined,
	includeFallbackTask: boolean,
): CompiledStep {
	const task = step.task ?? (includeFallbackTask ? fallbackTask : undefined);
	const compiled: CompiledStep = { agent: step.name };
	if (task) compiled.task = task;
	if (step.config.output !== undefined) compiled.output = step.config.output;
	if (step.config.outputMode !== undefined)
		compiled.outputMode = step.config.outputMode;
	if (step.config.reads !== undefined) compiled.reads = step.config.reads;
	if (step.config.progress !== undefined)
		compiled.progress = step.config.progress;
	if (step.config.skill !== undefined) compiled.skill = step.config.skill;
	if (step.config.model !== undefined) compiled.model = step.config.model;
	return compiled;
}

export function compileStoredCommand(
	command: string,
): CompileStoredCommandResult {
	const raw = command.trim();
	if (!raw) return { ok: false, errors: ["Command must not be empty"] };
	if (raw.includes("--bg"))
		return { ok: false, errors: ["Command cannot contain --bg"] };

	const { body, fork } = stripTrailingForkFlag(raw);
	const kind = getStoredCommandKind(body);
	if (!kind) {
		return {
			ok: false,
			errors: ["Command must start with /chain or /parallel"],
		};
	}

	const prefix = kind === "chain" ? "/chain" : "/parallel";
	const args = body.slice(prefix.length).trim();
	const parsed = parseStoredCommandArgs(kind, args);
	if (!parsed.ok) return { ok: false, errors: [parsed.error] };

	if (kind === "chain") {
		const chain = parsed.steps.map((step, index) =>
			buildStep(step, parsed.sharedTask, index === 0),
		);
		const params: CompiledChainParams = {
			chain,
			task: parsed.sharedTask,
			clarify: false,
			agentScope: "both",
		};
		if (fork) params.context = "fork";
		return { ok: true, kind, params };
	}

	const tasks = parsed.steps.map((step) =>
		buildStep(step, parsed.sharedTask, true),
	);
	const params: CompiledParallelParams = {
		tasks,
		clarify: false,
		agentScope: "both",
	};
	if (fork) params.context = "fork";
	return { ok: true, kind, params };
}
