import type { ExecutionCursor } from "./plan-schemas.ts";
import { getPlanOrchestratorConfig } from "./plan-orchestrator-config.ts";

export interface SessionEntryLike {
	type?: string;
	customType?: string;
	content?: string | Array<{ type?: string; text?: string }>;
}

export interface ResumeEvidenceItem {
	executionIndex: number;
	content: string;
}

export interface ResumeEvidenceBundle {
	cursor: ExecutionCursor;
	entries: ResumeEvidenceItem[];
	completedPrefix: ResumeEvidenceItem[];
	failedCommand?: ResumeEvidenceItem;
}

function isNoActiveCursor(cursor: ExecutionCursor): boolean {
	return cursor.stepIndex === -1 && cursor.commandIndex === -1;
}

function contentToText(content: SessionEntryLike["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				part?.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}

function extractSubagentResultSection(content: string): string | undefined {
	const normalized = content.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");
	const startIndex = lines.findIndex((line) =>
		/^##\s*subagent\s*result\s*$/i.test(line.trim()),
	);
	if (startIndex === -1) return undefined;

	let endIndex = lines.length;
	for (let i = startIndex + 1; i < lines.length; i += 1) {
		if (/^##\s+/.test(lines[i] ?? "")) {
			endIndex = i;
			break;
		}
	}

	return lines.slice(startIndex, endIndex).join("\n").trim();
}

function truncateEvidence(content: string): string {
	const maxChars = getPlanOrchestratorConfig().resumeEvidence.maxEvidenceChars;
	return content.length > maxChars ? content.slice(0, maxChars) : content;
}

function isQualifyingFinalSlashResult(
	entry: SessionEntryLike,
): entry is SessionEntryLike {
	return entry.customType === "subagent-slash-result";
}

export function collectResumeEvidence(
	entries: SessionEntryLike[],
	cursor: ExecutionCursor,
): ResumeEvidenceBundle {
	const orderedEntries: ResumeEvidenceItem[] = [];
	let executionIndex = 0;
	for (const entry of entries) {
		if (!isQualifyingFinalSlashResult(entry)) continue;
		const section = extractSubagentResultSection(contentToText(entry.content));
		if (!section) continue;
		orderedEntries.push({
			executionIndex,
			content: truncateEvidence(section),
		});
		executionIndex += 1;
	}

	if (isNoActiveCursor(cursor)) {
		return {
			cursor,
			entries: orderedEntries,
			completedPrefix: orderedEntries,
		};
	}

	const failedCommand = orderedEntries.at(-1);
	return {
		cursor,
		entries: orderedEntries,
		completedPrefix: failedCommand
			? orderedEntries.slice(0, -1)
			: orderedEntries,
		...(failedCommand ? { failedCommand } : {}),
	};
}
