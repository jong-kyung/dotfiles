import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildRemovePlan,
	buildUpdatePlan,
	collectInventory,
	defaultPaths,
	formatPlan,
	formatStatus,
	isSafeRemovablePath,
	resolveTarget,
	type PathsConfig,
	type Resolution,
} from "./lifecycle";

function fixturePaths(): PathsConfig {
	const root = mkdtempSync(join(tmpdir(), "skill-lifecycle-test-"));
	const cwd = join(root, "repo");
	const agentDir = join(root, ".pi", "agent");
	const agentsDir = join(root, ".agents");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(agentsDir, { recursive: true });
	return {
		...defaultPaths(cwd),
		cwd,
		agentDir,
		agentsDir,
		compoundManifestPath: join(agentDir, "compound-engineering", "install-manifest.json"),
		npxSkillLockPath: join(agentsDir, ".skill-lock.json"),
		userSettingsPath: join(agentDir, "settings.json"),
		projectSettingsPath: join(cwd, ".pi", "settings.json"),
		lockPath: join(root, "lock"),
	};
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2));
}

function seedInventory(paths: PathsConfig): void {
	writeJson(paths.compoundManifestPath, {
		pluginName: "compound-engineering",
		skills: ["ce-plan", "ce-work", "lfg"],
		agents: ["ce-repo-research-analyst.md"],
	});
	writeJson(paths.npxSkillLockPath, {
		version: 3,
		skills: {
			"agent-browser": {
				source: "vercel-labs/agent-browser",
				sourceUrl: "https://github.com/vercel-labs/agent-browser.git",
			},
		},
	});
	writeJson(paths.userSettingsPath, { packages: ["npm:pi-subagents"] });
}

describe("target resolution", () => {
	test("resolves compound-engineering as the package-level update target", () => {
		const paths = fixturePaths();
		seedInventory(paths);
		const inventory = collectInventory(paths.cwd, [], paths);
		const resolution = resolveTarget("compound-engineering", inventory);

		expect(resolution.status).toBe("resolved");
		if (resolution.status !== "resolved") return;
		expect(resolution.candidate.kind).toBe("bundle");
		expect(resolution.candidate.update).toBe("supported");
		expect(resolution.candidate.resources.find((resource) => resource.label === "skills")?.count).toBe(3);
	});

	test("resolves bundle members to the canonical compound owner", () => {
		const paths = fixturePaths();
		seedInventory(paths);
		const inventory = collectInventory(paths.cwd, [], paths);
		const resolution = resolveTarget("/skill:lfg", inventory);

		expect(resolution.status).toBe("resolved");
		if (resolution.status !== "resolved") return;
		expect(resolution.candidate.kind).toBe("bundle-member");
		expect(resolution.candidate.canonicalTarget).toBe("compound-engineering");
		expect(resolution.candidate.remove).toBe("guidance-only");
	});

	test("keeps Compound bundle ownership ahead of loaded skill runtime commands", () => {
		const paths = fixturePaths();
		seedInventory(paths);
		const commandPath = join(paths.agentDir, "skills", "lfg", "SKILL.md");
		mkdirSync(join(paths.agentDir, "skills", "lfg"), { recursive: true });
		writeFileSync(commandPath, "---\nname: lfg\ndescription: test\n---\n");
		const inventory = collectInventory(paths.cwd, [{ name: "skill:lfg", source: "skill", sourceInfo: { path: commandPath } } as any], paths);
		const resolution = resolveTarget("lfg", inventory);

		expect(resolution.status).toBe("resolved");
		if (resolution.status !== "resolved") return;
		expect(resolution.candidate.kind).toBe("bundle-member");
		expect(resolution.candidate.manager).toBe("compound-plugin");
	});

	test("resolves npx skills as external and guidance-only for removal", () => {
		const paths = fixturePaths();
		seedInventory(paths);
		const inventory = collectInventory(paths.cwd, [], paths);
		const resolution = resolveTarget("agent-browser", inventory);

		expect(resolution.status).toBe("resolved");
		if (resolution.status !== "resolved") return;
		expect(resolution.candidate.manager).toBe("npx-skills");
		expect(resolution.candidate.remove).toBe("guidance-only");
		expect(buildRemovePlan(resolution).supported).toBe(false);
	});

	test("resolves configured Pi packages as removable", () => {
		const paths = fixturePaths();
		seedInventory(paths);
		const inventory = collectInventory(paths.cwd, [], paths);
		const resolution = resolveTarget("pi-subagents", inventory);

		expect(resolution.status).toBe("resolved");
		if (resolution.status !== "resolved") return;
		expect(resolution.candidate.kind).toBe("pi-package");
		const plan = buildRemovePlan(resolution);
		expect(plan.supported).toBe(true);
		expect(plan.command?.display).toBe("pi remove npm:pi-subagents");
	});

	test("does not allow non-compound mutating updates in v1", () => {
		const paths = fixturePaths();
		seedInventory(paths);
		const inventory = collectInventory(paths.cwd, [], paths);
		const resolution = resolveTarget("pi-subagents", inventory);
		const plan = buildUpdatePlan(resolution);

		expect(plan.supported).toBe(false);
		expect(plan.guidanceOnly).toBe(true);
	});

	test("does not hide runtime commands from sibling prefix paths", () => {
		const paths = fixturePaths();
		seedInventory(paths);
		mkdirSync(join(paths.agentsDir, "skills", "agent-browser"), { recursive: true });
		const siblingPath = join(paths.agentsDir, "skills", "agent-browser-evil", "SKILL.md");
		mkdirSync(join(paths.agentsDir, "skills", "agent-browser-evil"), { recursive: true });
		writeFileSync(siblingPath, "---\nname: agent-browser\ndescription: test\n---\n");
		const inventory = collectInventory(paths.cwd, [{ name: "agent-browser", source: "extension", sourceInfo: { path: siblingPath } } as any], paths);
		const resolution = resolveTarget("agent-browser", inventory);

		expect(resolution.status).toBe("ambiguous");
		if (resolution.status !== "ambiguous") return;
		expect(resolution.candidates.map((candidate) => candidate.manager).sort()).toEqual(["npx-skills", "runtime-command"]);
	});
});


describe("display redaction", () => {
	test("redacts credentials from status and plan output", () => {
		const source = "git:https://user:password@example.com/org/private.git?token=abc123";
		const resolution: Resolution = {
			status: "resolved",
			candidate: {
				kind: "pi-package",
				manager: "pi-package",
				confidence: "exact",
				canonicalTarget: "private",
				displayName: "private",
				source,
				resources: [{ label: "package source", path: source, manager: "pi-package" }],
				notes: [],
				update: "guidance-only",
				remove: "supported",
				piPackage: { name: "private", source, scope: "user", filtered: false },
			},
		};
		const status = formatStatus(resolution, { warnings: [] } as any);
		const plan = formatPlan(buildRemovePlan(resolution));

		expect(status).not.toContain("password");
		expect(status).not.toContain("abc123");
		expect(plan).not.toContain("password");
		expect(plan).not.toContain("abc123");
		expect(status).toContain("token=…");
	});
});

describe("path safety", () => {
	test("accepts regular paths under allowed roots", () => {
		const root = mkdtempSync(join(tmpdir(), "skill-lifecycle-path-"));
		const allowed = join(root, "allowed");
		const file = join(allowed, "skill", "SKILL.md");
		mkdirSync(join(allowed, "skill"), { recursive: true });
		writeFileSync(file, "---\nname: skill\ndescription: test\n---\n");

		expect(isSafeRemovablePath(file, [allowed]).safe).toBe(true);
	});

	test("rejects symlinks and out-of-root paths", () => {
		const root = mkdtempSync(join(tmpdir(), "skill-lifecycle-path-"));
		const allowed = join(root, "allowed");
		const outside = join(root, "outside.txt");
		const link = join(allowed, "link");
		mkdirSync(allowed, { recursive: true });
		writeFileSync(outside, "outside");
		symlinkSync(outside, link);

		expect(isSafeRemovablePath(link, [allowed]).safe).toBe(false);
		expect(isSafeRemovablePath(outside, [allowed]).safe).toBe(false);
	});
});
