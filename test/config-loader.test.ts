import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { loadPlanOrchestratorConfigFromDisk } from "../src/plan-orchestrator-config.ts";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-plan-orchestrator-config-"));
}

test("config loader applies home config, then overrides with local config", () => {
	const tmp = makeTempDir();
	const homeDir = path.join(tmp, "home", "pi-plan-orchestrator");
	const localDir = path.join(tmp, "local", "pi-plan-orchestrator");

	fs.mkdirSync(homeDir, { recursive: true });
	fs.mkdirSync(localDir, { recursive: true });

	fs.writeFileSync(
		path.join(homeDir, "config.yaml"),
		"ui:\n  widgetHeading: Home Heading\n",
		"utf8",
	);
	fs.writeFileSync(
		path.join(localDir, "config.yaml"),
		"ui:\n  widgetHeading: Local Heading\n",
		"utf8",
	);

	const config = loadPlanOrchestratorConfigFromDisk({
		homeConfigPath: homeDir,
		localConfigPath: localDir,
	});

	assert.equal(config.ui.widgetHeading, "Local Heading");
	assert.equal(config.ui.widgetKey, "plan-orchestrator");
});

test("config loader normalizes slashBridge.defaultTimeoutMs into the runtime timeout setting", () => {
	const tmp = makeTempDir();
	const homeDir = path.join(tmp, "home", "pi-plan-orchestrator");
	const localDir = path.join(tmp, "local", "pi-plan-orchestrator");

	fs.mkdirSync(homeDir, { recursive: true });
	fs.mkdirSync(localDir, { recursive: true });

	fs.writeFileSync(
		path.join(localDir, "config.yaml"),
		"slashBridge:\n  defaultTimeoutMs: 12345\n",
		"utf8",
	);

	const config = loadPlanOrchestratorConfigFromDisk({
		homeConfigPath: homeDir,
		localConfigPath: localDir,
	});

	assert.equal(config.slashBridge.defaultTimeoutMs, 12345);
	assert.equal(config.slashBridge.connectionTimeoutMs, 12345);
});

test("config loader uses home config when local config is missing", () => {
	const tmp = makeTempDir();
	const homeDir = path.join(tmp, "home", "pi-plan-orchestrator");
	const localDir = path.join(tmp, "local", "pi-plan-orchestrator");

	fs.mkdirSync(homeDir, { recursive: true });
	fs.writeFileSync(
		path.join(homeDir, "config.yaml"),
		"ui:\n  widgetHeading: Home Heading\n",
		"utf8",
	);

	const config = loadPlanOrchestratorConfigFromDisk({
		homeConfigPath: homeDir,
		localConfigPath: localDir,
	});

	assert.equal(config.ui.widgetHeading, "Home Heading");
});
