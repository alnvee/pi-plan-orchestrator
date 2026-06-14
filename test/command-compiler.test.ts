import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { compileStoredCommand } from "../src/command-compiler.ts";

// Make skill discovery deterministic.
const agentDir = fs.mkdtempSync(
	path.join(os.tmpdir(), "pi-plan-orchestrator-test-agent-dir-"),
);
const skillsRoot = path.join(agentDir, "skills");
fs.mkdirSync(skillsRoot, { recursive: true });

for (const skillName of ["notebooklm", "mcp"]) {
	const dir = path.join(skillsRoot, skillName);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "SKILL.md"), `name: ${skillName}\n`, "utf8");
}

process.env.PI_CODING_AGENT_DIR = agentDir;
process.on("exit", () => {
	try {
		fs.rmSync(agentDir, { recursive: true, force: true });
	} catch {
		// Best effort cleanup.
	}
});

test("compileStoredCommand compiles a valid /chain command", () => {
	const result = compileStoredCommand(
		'/chain scout[output=context.md] "scan code" -> planner[reads=context.md] "analyze auth" --fork',
	);

	assert.deepEqual(result, {
		ok: true,
		kind: "chain",
		params: {
			chain: [
				{ agent: "scout", task: "scan code", output: "context.md" },
				{ agent: "planner", task: "analyze auth", reads: ["context.md"] },
			],
			task: "scan code",
			clarify: false,
			agentScope: "both",
			context: "fork",
		},
	});
});

test("compileStoredCommand auto-injects notebooklm skill when task references NotebookLM", () => {
	const result = compileStoredCommand(
		'/chain scout "Extract NotebookLM z from source" -> reviewer "Validate NotebookLM snippet" -> worker "Edit strategy.md"',
	);

	assert.deepEqual(result, {
		ok: true,
		kind: "chain",
		params: {
			chain: [
				{
					agent: "scout",
					task: "Extract NotebookLM z from source",
					skill: ["notebooklm"],
				},
				{
					agent: "reviewer",
					task: "Validate NotebookLM snippet",
					skill: ["notebooklm"],
				},
				{ agent: "worker", task: "Edit strategy.md" },
			],
			task: "Extract NotebookLM z from source",
			clarify: false,
			agentScope: "both",
		},
	});
});

test("compileStoredCommand auto-injects mcp skill when task references MCP", () => {
	const result = compileStoredCommand(
		'/chain scout "Use MCP tools to extract z" -> worker "Edit strategy.md"',
	);

	assert.deepEqual(result, {
		ok: true,
		kind: "chain",
		params: {
			chain: [
				{
					agent: "scout",
					task: "Use MCP tools to extract z",
					skill: ["mcp"],
				},
				{ agent: "worker", task: "Edit strategy.md" },
			],
			task: "Use MCP tools to extract z",
			clarify: false,
			agentScope: "both",
		},
	});
});

test("compileStoredCommand preserves explicit skill=false when task references NotebookLM", () => {
	const result = compileStoredCommand(
		'/chain scout[skill=false] "Extract NotebookLM z from source" -> worker "Edit strategy.md"',
	);

	assert.deepEqual(result, {
		ok: true,
		kind: "chain",
		params: {
			chain: [
				{
					agent: "scout",
					task: "Extract NotebookLM z from source",
					skill: false,
				},
				{ agent: "worker", task: "Edit strategy.md" },
			],
			task: "Extract NotebookLM z from source",
			clarify: false,
			agentScope: "both",
		},
	});
});

test("compileStoredCommand appends notebooklm skill when task references NotebookLM and skills list already set", () => {
	const result = compileStoredCommand(
		'/chain scout[skills=code-review] "Extract NotebookLM z from source" -> worker "Edit strategy.md"',
	);

	assert.deepEqual(result, {
		ok: true,
		kind: "chain",
		params: {
			chain: [
				{
					agent: "scout",
					task: "Extract NotebookLM z from source",
					skill: ["code-review", "notebooklm"],
				},
				{ agent: "worker", task: "Edit strategy.md" },
			],
			task: "Extract NotebookLM z from source",
			clarify: false,
			agentScope: "both",
		},
	});
});

test("compileStoredCommand compiles a valid /chain shared-task command", () => {
	const result = compileStoredCommand(
		"/chain scout planner -- analyze the auth system",
	);

	assert.deepEqual(result, {
		ok: true,
		kind: "chain",
		params: {
			chain: [
				{ agent: "scout", task: "analyze the auth system" },
				{ agent: "planner" },
			],
			task: "analyze the auth system",
			clarify: false,
			agentScope: "both",
		},
	});
});

test("compileStoredCommand compiles a valid /parallel command", () => {
	const result = compileStoredCommand(
		"/parallel scout reviewer -- check for security issues",
	);

	assert.deepEqual(result, {
		ok: true,
		kind: "parallel",
		params: {
			tasks: [
				{ agent: "scout", task: "check for security issues" },
				{ agent: "reviewer", task: "check for security issues" },
			],
			clarify: false,
			agentScope: "both",
		},
	});
});

test("compileStoredCommand allows --fork on /parallel", () => {
	const result = compileStoredCommand(
		"/parallel scout reviewer -- check for security issues --fork",
	);

	assert.deepEqual(result, {
		ok: true,
		kind: "parallel",
		params: {
			tasks: [
				{ agent: "scout", task: "check for security issues" },
				{ agent: "reviewer", task: "check for security issues" },
			],
			clarify: false,
			agentScope: "both",
			context: "fork",
		},
	});
});

test("compileStoredCommand preserves inline config for parallel steps", () => {
	const result = compileStoredCommand(
		'/parallel reviewer[skills=code-review+security] "review backend" -> reviewer[model=openai/gpt-5-mini] "review frontend"',
	);

	assert.deepEqual(result, {
		ok: true,
		kind: "parallel",
		params: {
			tasks: [
				{
					agent: "reviewer",
					task: "review backend",
					skill: ["code-review", "security"],
				},
				{
					agent: "reviewer",
					task: "review frontend",
					model: "openai/gpt-5-mini",
				},
			],
			clarify: false,
			agentScope: "both",
		},
	});
});

test("compileStoredCommand rejects commands outside /chain and /parallel", () => {
	const result = compileStoredCommand('/run planner "draft a plan"');

	assert.equal(result.ok, false);
	if (result.ok) throw new Error("Expected compileStoredCommand to fail");
	assert.match(result.errors[0] ?? "", /start with \/chain or \/parallel/);
});

test("compileStoredCommand rejects any command containing --bg", () => {
	const result = compileStoredCommand(
		'/chain scout "analyze auth" -> planner "design refactor" --bg',
	);

	assert.equal(result.ok, false);
	if (result.ok) throw new Error("Expected compileStoredCommand to fail");
	assert.match(result.errors[0] ?? "", /cannot contain --bg/);
});

test("compileStoredCommand rejects invalid /chain per-step grammar", () => {
	const result = compileStoredCommand('/chain scout -> planner "task"');
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("Expected compileStoredCommand to fail");
	assert.match(result.errors[0] ?? "", /First step must have a task/);
});

test("compileStoredCommand rejects /chainX and /parallelX tokens", () => {
	const badChain = compileStoredCommand(
		"/chainX scout planner -- analyze the auth system",
	);
	assert.equal(badChain.ok, false);
	if (badChain.ok) throw new Error("Expected compileStoredCommand to fail");
	assert.match(badChain.errors[0] ?? "", /start with \/chain or \/parallel/);

	const badParallel = compileStoredCommand(
		"/parallelX scout reviewer -- check for security issues",
	);
	assert.equal(badParallel.ok, false);
	if (badParallel.ok) throw new Error("Expected compileStoredCommand to fail");
	assert.match(badParallel.errors[0] ?? "", /start with \/chain or \/parallel/);
});
