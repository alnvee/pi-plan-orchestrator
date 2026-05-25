import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import registerPlanOrchestrator, {
	registerPlanOrchestratorExtension,
} from "../src/index.ts";

const packageJson = JSON.parse(
	fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
);

test("package manifest points at the extension entrypoint", () => {
	assert.deepEqual(packageJson.pi?.extensions, ["./src/index.ts"]);
});

test("package manifest keeps Pi peer dependencies and local runtime dependencies in place", () => {
	assert.equal(packageJson.dependencies?.["pi-subagents"], "^0.25.0");
	assert.equal(packageJson.dependencies?.typebox, "^1.1.24");
	assert.equal(
		packageJson.peerDependencies?.["@earendil-works/pi-coding-agent"],
		"*",
	);
	assert.equal(packageJson.peerDependencies?.["@earendil-works/pi-ai"], "*");
	assert.equal(packageJson.peerDependencies?.["@earendil-works/pi-tui"], "*");
});

test("package manifest is publishable and discoverable", () => {
	assert.equal(packageJson.private, false);
	assert.equal(packageJson.license, "MIT");
	assert.ok(packageJson.keywords?.includes("pi-package"));
	assert.deepEqual(packageJson.files, ["src", "README.md", "LICENSE"]);
});

test("src/index.ts exposes the default extension registration function", () => {
	assert.equal(typeof registerPlanOrchestrator, "function");
	assert.equal(typeof registerPlanOrchestratorExtension, "function");
});
