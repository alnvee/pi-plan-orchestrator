import {
	getStoredCommandKind,
	type StoredCommandKind,
} from "./stored-command.ts";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

type AutoInjectSkill = {
	name: string;
	normalized: string;
};

let autoInjectSkillsCache: {
	agentDir: string;
	skills: AutoInjectSkill[];
} | null = null;

function resolveAgentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	if (configured === "~") return os.homedir();
	if (configured?.startsWith("~/"))
		return path.join(os.homedir(), configured.slice(2));
	return configured || path.join(os.homedir(), ".pi", "agent");
}

function normalizeForSkillMatch(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function collectSkillNamesFromLocalSkills(skillsRoot: string): Set<string> {
	const found = new Set<string>();
	if (!fs.existsSync(skillsRoot)) return found;

	const MAX_DEPTH = 12;

	function walk(dir: string, depth: number): void {
		if (depth > MAX_DEPTH) return;

		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (entry.isSymbolicLink()) continue;

			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full, depth + 1);
				continue;
			}

			if (entry.isFile() && entry.name.toLowerCase() === "skill.md") {
				found.add(path.basename(path.dirname(full)));
			}
		}
	}

	walk(skillsRoot, 0);
	return found;
}

function collectSkillNamesFromPackagedSkills(
	nodeModulesRoot: string,
): Set<string> {
	const found = new Set<string>();
	if (!fs.existsSync(nodeModulesRoot)) return found;

	function collectFromPackage(packageRoot: string): void {
		const skillsRoot = path.join(packageRoot, "skills");
		if (!fs.existsSync(skillsRoot)) return;

		let skillEntries: fs.Dirent[];
		try {
			skillEntries = fs.readdirSync(skillsRoot, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of skillEntries) {
			if (entry.isSymbolicLink()) continue;
			if (!entry.isDirectory()) continue;

			const skillMd = path.join(skillsRoot, entry.name, "SKILL.md");
			if (fs.existsSync(skillMd)) found.add(entry.name);
		}
	}

	let packages: fs.Dirent[];
	try {
		packages = fs.readdirSync(nodeModulesRoot, { withFileTypes: true });
	} catch {
		return found;
	}

	for (const pkg of packages) {
		if (pkg.isSymbolicLink() || !pkg.isDirectory()) continue;

		if (pkg.name.startsWith("@")) {
			const scopeRoot = path.join(nodeModulesRoot, pkg.name);
			let scopedPackages: fs.Dirent[];
			try {
				scopedPackages = fs.readdirSync(scopeRoot, { withFileTypes: true });
			} catch {
				continue;
			}

			for (const scoped of scopedPackages) {
				if (scoped.isSymbolicLink() || !scoped.isDirectory()) continue;
				collectFromPackage(path.join(scopeRoot, scoped.name));
			}
		} else {
			collectFromPackage(path.join(nodeModulesRoot, pkg.name));
		}
	}

	return found;
}

function getAutoInjectSkills(): AutoInjectSkill[] {
	const agentDir = resolveAgentDir();
	if (autoInjectSkillsCache?.agentDir === agentDir)
		return autoInjectSkillsCache.skills;

	const skillNames = new Set<string>();

	const localSkillsRoot = path.join(agentDir, "skills");
	for (const name of collectSkillNamesFromLocalSkills(localSkillsRoot)) {
		skillNames.add(name);
	}

	const packagedNodeModulesRoot = path.join(agentDir, "npm", "node_modules");
	for (const name of collectSkillNamesFromPackagedSkills(
		packagedNodeModulesRoot,
	)) {
		skillNames.add(name);
	}

	// Avoid injecting the orchestration/orchestrator meta-skill.
	skillNames.delete("pi-subagents");

	const names = Array.from(skillNames).filter(Boolean);

	names.sort((a, b) => a.localeCompare(b));

	const skills = names.map((name) => ({
		name,
		normalized: normalizeForSkillMatch(name),
	}));

	autoInjectSkillsCache = { agentDir, skills };
	return skills;
}

function getSkillsMentionedInTask(task: string): string[] {
	const normalizedTask = normalizeForSkillMatch(task);
	if (!normalizedTask) return [];

	const autoSkills = getAutoInjectSkills();
	const mentioned: string[] = [];
	for (const skill of autoSkills) {
		if (skill.normalized && normalizedTask.includes(skill.normalized)) {
			mentioned.push(skill.name);
		}
	}
	return mentioned;
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

	// Auto-inject any known skills mentioned in the task text so subagents
	// have the corresponding skill instructions available without requiring the
	// plan author to explicitly add skill=<skillName>.
	if (
		typeof compiled.task === "string" &&
		compiled.task.trim().length > 0 &&
		compiled.skill !== false
	) {
		const mentionedSkills = getSkillsMentionedInTask(compiled.task);
		if (mentionedSkills.length > 0) {
			if (compiled.skill === undefined) {
				compiled.skill = mentionedSkills;
			} else {
				const next = [...compiled.skill];
				for (const skillName of mentionedSkills) {
					if (!next.includes(skillName)) next.push(skillName);
				}
				compiled.skill = next;
			}
		}
	}

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
