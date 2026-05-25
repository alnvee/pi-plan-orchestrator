export type StoredCommandKind = "chain" | "parallel";

function startsWithCommandToken(
	command: string,
	token: "/chain" | "/parallel",
): boolean {
	const trimmed = command.trimStart();
	if (!trimmed.startsWith(token)) return false;

	// Exact token match: `/chain` or `/parallel` with nothing after.
	if (trimmed.length === token.length) return true;

	const next = trimmed[token.length]!;
	// Require token boundary: next char must be whitespace.
	return (
		next === " " ||
		next === "\n" ||
		next === "\t" ||
		next === "\r" ||
		next === "\f" ||
		next === "\v"
	);
}

export function getStoredCommandKind(
	command: string,
): StoredCommandKind | null {
	if (startsWithCommandToken(command, "/chain")) return "chain";
	if (startsWithCommandToken(command, "/parallel")) return "parallel";
	return null;
}

export function isStoredCommandString(command: string): boolean {
	return getStoredCommandKind(command) !== null;
}
