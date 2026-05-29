import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Plan, ExecutionCursor } from "../plan-schemas.ts";
import type { CommandExecutionResult } from "../plan-execution.ts";
import type { ResumeEvidenceBundle } from "../resume-evidence.ts";
import { getStoredCommandKind } from "../stored-command.ts";
import { getPlanOrchestratorConfig } from "../plan-orchestrator-config.ts";

type Theme = ExtensionContext["ui"]["theme"];
type WidgetFactory = (_tui: unknown, theme: Theme) => Component;

const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function runningGlyph(seed?: number): string {
	if (seed === undefined) return "●";
	return RUNNING_FRAMES[Math.abs(seed) % RUNNING_FRAMES.length]!;
}

function getTermWidth(): number {
	return process.stdout.columns || 120;
}

function truncLine(text: string, maxWidth: number): string {
	if (visibleWidth(text) <= maxWidth) return text;
	const targetWidth = maxWidth - 1;
	let result = "";
	let currentWidth = 0;
	let i = 0;
	while (i < text.length) {
		const ansiMatch = text.slice(i).match(/^\x1b\[[0-9;]*m/);
		if (ansiMatch) {
			result += ansiMatch[0];
			i += ansiMatch[0].length;
			continue;
		}
		const ch = text[i]!;
		const chWidth = visibleWidth(ch);
		if (currentWidth + chWidth > targetWidth) break;
		result += ch;
		currentWidth += chWidth;
		i++;
	}
	return result + "…";
}

function describeCount(n: number, singular: string): string {
	return n === 1 ? `${n} ${singular}` : `${n} ${singular}s`;
}

function makeFactory(buildLines: (theme: Theme, width: number) => string[]): WidgetFactory {
	return (_tui, theme) => {
		const width = getTermWidth();
		const lines = buildLines(theme, width);
		const container = new Container();
		for (const line of lines) container.addChild(new Text(line, 1, 0));
		return container;
	};
}

// ─── Plan review widget ────────────────────────────────────────────────────────

export function buildPlanWidgetFactory(plan: Plan, expanded: boolean): WidgetFactory {
	return makeFactory((theme, width) => {
		const ui = getPlanOrchestratorConfig().ui;
		let commandCount = 0;
		let chainCommandCount = 0;
		let parallelCommandCount = 0;
		for (const step of plan.steps) {
			for (const command of step.commands) {
				commandCount++;
				const kind = getStoredCommandKind(command);
				if (kind === "chain") chainCommandCount++;
				if (kind === "parallel") parallelCommandCount++;
			}
		}
		const overviewParts: string[] = [
			describeCount(plan.steps.length, "step"),
			describeCount(commandCount, "command"),
		];
		if (chainCommandCount > 0) {
			overviewParts.push(describeCount(chainCommandCount, "chain command"));
		}
		if (parallelCommandCount > 0) {
			overviewParts.push(describeCount(parallelCommandCount, "parallel command"));
		}
		const lines: string[] = [
			theme.fg("accent", ui.widgetHeading),
			`${ui.goalLabelPrefix}${truncLine(plan.goal, width - ui.goalLabelPrefix.length - 2)}`,
			theme.fg("dim", `Overview: ${overviewParts.join(", ")}`),
			"",
			theme.fg("dim", "Review checklist"),
			theme.fg("dim", "- Goal matches your request"),
			theme.fg("dim", "- Step order looks right"),
			theme.fg("dim", "- Command order matches the intended execution"),
			"",
			"Steps",
			"",
		];
		plan.steps.forEach((step, index) => {
			lines.push(`${index + 1}. ${truncLine(step.title, width - 5)}`);
			if (expanded) {
				if (step.description) {
					lines.push(
						theme.fg(
							"dim",
							`${ui.descriptionIndent}Description: ${truncLine(step.description, width - ui.descriptionIndent.length - 14)}`,
						),
					);
				}
				lines.push(
					theme.fg(
						"dim",
						`${ui.descriptionIndent}Commands: ${describeCount(step.commands.length, "command")}`,
					),
				);
				for (const command of step.commands) {
					lines.push(
						theme.fg(
							"dim",
							`${ui.commandIndent}${truncLine(command, width - ui.commandIndent.length - 2)}`,
						),
					);
				}
			} else {
				lines.push(
					theme.fg(
						"dim",
						`${ui.descriptionIndent}${describeCount(step.commands.length, "command")}`,
					),
				);
			}
			lines.push("");
		});
		return lines;
	});
}

// ─── Execution widget ─────────────────────────────────────────────────────────

export function buildExecutionWidgetFactory(
	plan: Plan,
	activeStep: number,
	activeCommand: number,
	results: CommandExecutionResult[],
	expanded: boolean,
): WidgetFactory {
	return makeFactory((theme, width) => {
		const seed = Math.floor(Date.now() / 150);
		const spinnerFrame = runningGlyph(seed);
		const isRunning = activeStep >= 0;
		const lines: string[] = isRunning
			? [
					`${theme.fg("accent", spinnerFrame)} Step ${activeStep + 1} of ${plan.steps.length} — ${truncLine(plan.steps[activeStep]?.title ?? "", width - 20)}`,
					`Goal: ${truncLine(plan.goal, width - 7)}`,
					"",
				]
			: [`Executing: ${truncLine(plan.goal, width - 11)}`, ""];

		const resultMap = new Map<string, CommandExecutionResult>();
		for (const r of results) resultMap.set(`${r.stepIndex}:${r.commandIndex}`, r);

		plan.steps.forEach((step, stepIndex) => {
			if (expanded) {
				lines.push(`${stepIndex + 1}. ${truncLine(step.title, width - 5)}`);
				step.commands.forEach((command, commandIndex) => {
					const result = resultMap.get(`${stepIndex}:${commandIndex}`);
					const isActive = stepIndex === activeStep && commandIndex === activeCommand;
					let icon: string;
					if (isActive) {
						icon = theme.fg("accent", spinnerFrame);
					} else if (result) {
						icon = result.ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
					} else {
						icon = theme.fg("dim", "○");
					}
					lines.push(`  ${icon} ${truncLine(command, width - 6)}`);
				});
				lines.push("");
			} else {
				// Compact: one line per step with aggregate icon
				const stepResults = step.commands.map((_, ci) => resultMap.get(`${stepIndex}:${ci}`));
				const hasError = stepResults.some((r) => r && !r.ok);
				const isStepActive = stepIndex === activeStep;
				const allDone =
					step.commands.length > 0 && stepResults.every((r) => r !== undefined);
				let stepIcon: string;
				if (isStepActive) {
					stepIcon = theme.fg("accent", spinnerFrame);
				} else if (hasError) {
					stepIcon = theme.fg("error", "✗");
				} else if (allDone) {
					stepIcon = theme.fg("success", "✓");
				} else {
					stepIcon = theme.fg("dim", "○");
				}
				lines.push(`${stepIcon} ${stepIndex + 1}. ${truncLine(step.title, width - 8)}`);
			}
		});
		return lines;
	});
}

// ─── Merged plan widget ────────────────────────────────────────────────────────

export function buildMergedPlanWidgetFactory(
	plan: Plan,
	cursor: ExecutionCursor,
	expanded: boolean,
): WidgetFactory {
	return makeFactory((theme, width) => {
		const lines: string[] = [
			theme.fg("accent", `Merged plan: ${truncLine(plan.goal, width - 14)}`),
			"",
		];
		plan.steps.forEach((step, stepIndex) => {
			let marker: string;
			if (stepIndex < cursor.stepIndex) {
				marker = theme.fg("success", "✓");
			} else if (stepIndex === cursor.stepIndex) {
				marker = `${theme.fg("accent", "↻")} rewritten`;
			} else {
				marker = `${theme.fg("dim", "→")} new`;
			}
			lines.push(`${marker} ${stepIndex + 1}. ${truncLine(step.title, width - 10)}`);
			if (expanded) {
				for (const command of step.commands) {
					lines.push(`  ${theme.fg("dim", truncLine(command, width - 4))}`);
				}
			}
			lines.push("");
		});
		return lines;
	});
}

// ─── Resume review widget ─────────────────────────────────────────────────────

export function buildResumeWidgetFactory(
	plan: Plan,
	cursor: ExecutionCursor,
	evidence: ResumeEvidenceBundle,
): WidgetFactory {
	return makeFactory((theme, width) => {
		const ui = getPlanOrchestratorConfig().ui;
		let commandCount = 0;
		for (const step of plan.steps) commandCount += step.commands.length;
		const completedCount = evidence.completedPrefix.length;
		const failedLine = evidence.failedCommand
			? `Failed command evidence: command ${evidence.failedCommand.executionIndex + 1}`
			: "Failed command evidence: unavailable";
		return [
			theme.fg("accent", "Resume review"),
			`${ui.goalLabelPrefix}${truncLine(plan.goal, width - ui.goalLabelPrefix.length - 2)}`,
			`Cursor: step ${cursor.stepIndex + 1}, command ${cursor.commandIndex + 1}`,
			`Plan size: ${describeCount(plan.steps.length, "step")}, ${describeCount(commandCount, "command")}`,
			`Completed commands: ${describeCount(completedCount, "command")}`,
			theme.fg("dim", failedLine),
			"",
			theme.fg(
				"dim",
				"The remainder will be rewritten from the saved cursor before execution continues.",
			),
		];
	});
}

// ─── Plan history widget ───────────────────────────────────────────────────────

export function buildPlanHistoryWidgetFactory(plans: Plan[]): WidgetFactory {
	return makeFactory((theme, width) => {
		if (plans.length === 0) {
			return [theme.fg("dim", "No plan history found.")];
		}
		const lines: string[] = [
			`${theme.fg("accent", "Plan History")} ${theme.fg("dim", "(most recent last)")}`,
		];
		plans.forEach((p, i) => {
			lines.push(
				`${i + 1}. ${truncLine(p.goal, width - 8)} ${theme.fg("dim", `(${p.steps.length} step${p.steps.length === 1 ? "" : "s"})`)}`,
			);
		});
		return lines;
	});
}
