import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildRemovePlan,
	buildUpdatePlan,
	checkUnavailableFreshness,
	collectInventory,
	compareStableSemver,
	defaultPaths,
	filterCompletions,
	formatPlan,
	formatStatus,
	freshnessEvidenceForCandidate,
	freshnessFromFolderHash,
	freshnessFromRemote,
	highestStableSemver,
	isSafeRemovablePath,
	makeReceipt,
	resolveTarget,
	summarizeExecResult,
	withLifecycleLock,
	type PathsConfig,
	type Resolution,
} from "../skill-manager/lifecycle";

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

function bundleManifestPath(paths: PathsConfig, pluginName: string): string {
	return join(paths.agentDir, pluginName, "install-manifest.json");
}

function scopedPluginBundleManifestPath(paths: PathsConfig, scope: string, pluginName: string): string {
	return join(paths.agentDir, scope, pluginName, "install-manifest.json");
}

function seedInventory(paths: PathsConfig): void {
	writeJson(bundleManifestPath(paths, "base-plugin"), {
		pluginName: "base-plugin",
		skills: ["ce-plan", "ce-work", "lfg"],
		agents: ["ce-repo-research-analyst.md"],
	});
	writeJson(paths.npxSkillLockPath, {
		version: 3,
		skills: {
			"agent-browser": {
				source: "vercel-labs/agent-browser",
				sourceType: "github",
				sourceUrl: "https://github.com/vercel-labs/agent-browser.git",
				skillPath: "skills/agent-browser/SKILL.md",
				skillFolderHash: "c1470a475a0472fceda2401ea6763708a91680a8",
			},
		},
	});
	mkdirSync(join(paths.agentsDir, "skills", "agent-browser"), { recursive: true });
	writeFileSync(join(paths.agentsDir, "skills", "agent-browser", "SKILL.md"), "---\nname: agent-browser\ndescription: test\n---\n");
	writeJson(paths.userSettingsPath, { packages: ["npm:pi-subagents"] });
}

describe("target resolution", () => {
	test("resolves installed plugin bundle as the package-level status target", () => {
		const paths = fixturePaths();
		seedInventory(paths);
		const inventory = collectInventory(paths.cwd, [], paths);
		const resolution = resolveTarget("base-plugin", inventory);

		expect(resolution.status).toBe("resolved");
		if (resolution.status !== "resolved") return;
		expect(resolution.candidate.kind).toBe("bundle");
		expect(resolution.candidate.update).toBe("guidance-only");
		expect(resolution.candidate.resources.find((resource) => resource.label === "skills")?.count).toBe(3);
	});

	test("resolves bundle members to the canonical manifest owner", () => {
		const paths = fixturePaths();
		seedInventory(paths);
		const inventory = collectInventory(paths.cwd, [], paths);
		const resolution = resolveTarget("/skill:lfg", inventory);

		expect(resolution.status).toBe("resolved");
		if (resolution.status !== "resolved") return;
		expect(resolution.candidate.kind).toBe("bundle-member");
		expect(resolution.candidate.canonicalTarget).toBe("base-plugin");
		expect(resolution.candidate.remove).toBe("guidance-only");
		const plan = buildUpdatePlan(resolution);
		expect(plan.supported).toBe(false);
		expect(plan.guidanceOnly).toBe(true);
		expect(plan.command).toBeUndefined();
	});

	test("discovers additional plugin bundle manifests without hardcoded package names", () => {
		const paths = fixturePaths();
		seedInventory(paths);
		writeJson(bundleManifestPath(paths, "example-plugin"), {
			pluginName: "example-plugin",
			skills: ["example-skill"],
			agents: ["example-agent.md"],
		});
		const inventory = collectInventory(paths.cwd, [], paths);
		const memberResolution = resolveTarget("example-skill", inventory);

		expect(memberResolution.status).toBe("resolved");
		if (memberResolution.status !== "resolved") return;
		expect(memberResolution.candidate.kind).toBe("bundle-member");
		expect(memberResolution.candidate.canonicalTarget).toBe("example-plugin");
		expect(buildUpdatePlan(memberResolution).supported).toBe(false);
		expect(buildUpdatePlan(memberResolution).command).toBeUndefined();

		const bundleResolution = resolveTarget("example-plugin", inventory);
		expect(bundleResolution.status).toBe("resolved");
		if (bundleResolution.status !== "resolved") return;
		expect(buildRemovePlan(bundleResolution).supported).toBe(false);
		expect(buildRemovePlan(memberResolution).supported).toBe(false);
	});

	test("discovers scoped plugin bundle manifests", () => {
		const paths = fixturePaths();
		writeJson(scopedPluginBundleManifestPath(paths, "@scope", "plugin"), { pluginName: "@scope/plugin", skills: ["scoped-skill"], agents: [] });
		const inventory = collectInventory(paths.cwd, [], paths);
		const resolution = resolveTarget("scoped-skill", inventory);

		expect(resolution.status).toBe("resolved");
		if (resolution.status !== "resolved") return;
		expect(resolution.candidate.canonicalTarget).toBe("@scope/plugin");
		expect(buildUpdatePlan(resolution).supported).toBe(false);
		expect(buildUpdatePlan(resolution).command).toBeUndefined();
	});

	test("returns ambiguous for duplicate plugin bundle members", () => {
		const paths = fixturePaths();
		seedInventory(paths);
		writeJson(bundleManifestPath(paths, "example-plugin"), { pluginName: "example-plugin", skills: ["lfg"], agents: [] });
		const inventory = collectInventory(paths.cwd, [], paths);
		const resolution = resolveTarget("lfg", inventory);

		expect(resolution.status).toBe("ambiguous");
	});

	test("ignores unsafe plugin bundle names", () => {
		const paths = fixturePaths();
		writeJson(bundleManifestPath(paths, "bad"), { pluginName: "--bad", skills: ["bad-skill"], agents: [] });
		const inventory = collectInventory(paths.cwd, [], paths);
		const resolution = resolveTarget("bad-skill", inventory);

		expect(resolution.status).toBe("unsupported");
		expect(inventory.warnings.join("\n")).toContain("pluginName is missing or unsafe");
		expect(formatStatus(resolution, inventory)).toContain("Warnings:");
	});

	test("keeps plugin bundle ownership ahead of loaded skill runtime commands", () => {
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
		expect(resolution.candidate.manager).toBe("plugin-bundle");
	});

	test("resolves safe local npx skills with update and Pi-visibility removal supported", () => {
		const paths = fixturePaths();
		seedInventory(paths);
		const inventory = collectInventory(paths.cwd, [], paths);
		const resolution = resolveTarget("agent-browser", inventory);

		expect(resolution.status).toBe("resolved");
		if (resolution.status !== "resolved") return;
		expect(resolution.candidate.manager).toBe("npx-skills");
		expect(resolution.candidate.update).toBe("supported");
		expect(resolution.candidate.remove).toBe("supported");
		expect(buildUpdatePlan(resolution).supported).toBe(true);
		expect(buildUpdatePlan(resolution).command?.display).toBe("npx --yes skills@1.5.7 update agent-browser -g -y");
		expect(buildRemovePlan(resolution).supported).toBe(true);
		expect(buildRemovePlan(resolution).npxRemoveMode).toBe("pi-visibility");
		const globalPlan = buildRemovePlan(resolution, { npxRemoveMode: "global" });
		expect(globalPlan.supported).toBe(false);
		expect(globalPlan.guidanceOnly).toBe(true);
		expect(globalPlan.command).toBeUndefined();
	});

	test("does not collapse plugin bundle member completions", () => {
		const paths = fixturePaths();
		seedInventory(paths);
		const inventory = collectInventory(paths.cwd, [], paths);
		const completions = filterCompletions("", inventory)?.map((item) => item.value) ?? [];

		expect(completions).toContain("ce-plan");
		expect(completions).toContain("ce-work");
		expect(completions).toContain("lfg");
	});

	test("no-target status shows concise top-level owners instead of inferred bundle members", () => {
		const paths = fixturePaths();
		seedInventory(paths);
		const inventory = collectInventory(paths.cwd, [], paths);
		const resolution = resolveTarget("", inventory);
		const status = formatStatus(resolution, inventory);

		expect(status).toContain("Skill lifecycle status: target required");
		expect(status).toContain("Usage: `/skill-status <target>`");
		expect(status).toContain("Top-level targets:");
		expect(status).toContain("`base-plugin` — plugin-bundle");
		expect(status).toContain("`pi-subagents` — pi-package");
		expect(status).toContain("`agent-browser` — npx-skills");
		expect(status).not.toContain("`ce-plan`");
		expect(status).not.toContain("(inferred)");
	});

	test("keeps unverified npx skills guidance-only", () => {
		const paths = fixturePaths();
		seedInventory(paths);
		writeJson(paths.npxSkillLockPath, { version: 3, skills: { "agent-browser": { source: "vercel-labs/agent-browser" } } });
		const inventory = collectInventory(paths.cwd, [], paths);
		const resolution = resolveTarget("agent-browser", inventory);

		expect(resolution.status).toBe("resolved");
		if (resolution.status !== "resolved") return;
		expect(resolution.candidate.manager).toBe("npx-skills");
		expect(resolution.candidate.update).toBe("guidance-only");
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

	test("supports exact-one unpinned Pi package updates", () => {
		const paths = fixturePaths();
		seedInventory(paths);
		const inventory = collectInventory(paths.cwd, [], paths);
		const resolution = resolveTarget("pi-subagents", inventory);
		const plan = buildUpdatePlan(resolution);

		expect(plan.supported).toBe(true);
		expect(plan.command?.display).toBe("pi update npm:pi-subagents");
	});

	test("keeps pinned and duplicate Pi package updates guidance-only", () => {
		const pinnedPaths = fixturePaths();
		seedInventory(pinnedPaths);
		writeJson(pinnedPaths.userSettingsPath, { packages: ["npm:pi-subagents@1.2.3"] });
		let inventory = collectInventory(pinnedPaths.cwd, [], pinnedPaths);
		let resolution = resolveTarget("pi-subagents", inventory);
		expect(buildUpdatePlan(resolution).supported).toBe(false);

		const duplicatePaths = fixturePaths();
		seedInventory(duplicatePaths);
		writeJson(duplicatePaths.projectSettingsPath, { packages: ["npm:pi-subagents"] });
		inventory = collectInventory(duplicatePaths.cwd, [], duplicatePaths);
		resolution = resolveTarget("pi-subagents", inventory);
		expect(resolution.status).toBe("ambiguous");
		expect(buildUpdatePlan(resolution).supported).toBe(false);

		const sameSettingsDuplicatePaths = fixturePaths();
		seedInventory(sameSettingsDuplicatePaths);
		writeJson(sameSettingsDuplicatePaths.userSettingsPath, { packages: ["npm:pi-subagents", "npm:pi-subagents"] });
		inventory = collectInventory(sameSettingsDuplicatePaths.cwd, [], sameSettingsDuplicatePaths);
		resolution = resolveTarget("pi-subagents", inventory);
		expect(resolution.status).toBe("resolved");
		expect(buildUpdatePlan(resolution).supported).toBe(false);
		expect(buildRemovePlan(resolution).supported).toBe(false);
		expect(formatPlan(buildRemovePlan(resolution))).toContain("remove would not be exact-scope");

		const malformedPaths = fixturePaths();
		seedInventory(malformedPaths);
		mkdirSync(join(malformedPaths.projectSettingsPath, ".."), { recursive: true });
		writeFileSync(malformedPaths.projectSettingsPath, "{");
		inventory = collectInventory(malformedPaths.cwd, [], malformedPaths);
		resolution = resolveTarget("pi-subagents", inventory);
		expect(buildUpdatePlan(resolution).supported).toBe(false);
	});

	test("supports unpinned git packages and blocks git refs", () => {
		const paths = fixturePaths();
		seedInventory(paths);
		writeJson(paths.userSettingsPath, { packages: ["git:https://github.com/example/pi-plugin.git"] });
		let inventory = collectInventory(paths.cwd, [], paths);
		let resolution = resolveTarget("pi-plugin", inventory);
		expect(buildUpdatePlan(resolution).supported).toBe(true);
		expect(buildUpdatePlan(resolution).command?.display).toBe("pi update git:https://github.com/example/pi-plugin.git");

		writeJson(paths.userSettingsPath, { packages: ["git:https://github.com/example/pi-plugin.git#main"] });
		inventory = collectInventory(paths.cwd, [], paths);
		resolution = resolveTarget("pi-plugin", inventory);
		expect(buildUpdatePlan(resolution).supported).toBe(false);

		writeJson(paths.userSettingsPath, { packages: ["git:../../local-plugin"] });
		inventory = collectInventory(paths.cwd, [], paths);
		resolution = resolveTarget("local-plugin", inventory);
		expect(buildUpdatePlan(resolution).supported).toBe(false);
		expect(formatPlan(buildUpdatePlan(resolution))).toContain("not a safe unpinned npm/git spec");
	});

	test("skips malformed npx lock entries without discarding valid skills", () => {
		const paths = fixturePaths();
		seedInventory(paths);
		writeJson(paths.npxSkillLockPath, {
			version: 3,
			skills: {
				"agent-browser": {
					source: "vercel-labs/agent-browser",
					sourceType: "github",
					sourceUrl: "https://github.com/vercel-labs/agent-browser.git",
					skillPath: "skills/agent-browser/SKILL.md",
					skillFolderHash: "c1470a475a0472fceda2401ea6763708a91680a8",
				},
				bad: null,
			},
		});
		const inventory = collectInventory(paths.cwd, [], paths);
		const resolution = resolveTarget("agent-browser", inventory);

		expect(resolution.status).toBe("resolved");
		if (resolution.status !== "resolved") return;
		expect(resolution.candidate.update).toBe("supported");
		expect(inventory.warnings.join("\n")).toContain("Ignored malformed npx skills lock entry for bad");
	});

	test("rejects unsafe npx locked skill paths", () => {
		const paths = fixturePaths();
		seedInventory(paths);
		writeJson(paths.npxSkillLockPath, {
			version: 3,
			skills: {
				"agent-browser": {
					source: "vercel-labs/agent-browser",
					sourceType: "github",
					sourceUrl: "https://github.com/vercel-labs/agent-browser.git",
					skillPath: "../../evil/SKILL.md",
					skillFolderHash: "c1470a475a0472fceda2401ea6763708a91680a8",
				},
			},
		});
		const inventory = collectInventory(paths.cwd, [], paths);
		const resolution = resolveTarget("agent-browser", inventory);

		expect(resolution.status).toBe("resolved");
		if (resolution.status !== "resolved") return;
		expect(resolution.candidate.update).toBe("guidance-only");
		expect(resolution.candidate.notes.join("\n")).toContain("locked skillPath is unsafe");
	});

	test("returns ambiguous when npx and a different loose root claim the same name", () => {
		const paths = fixturePaths();
		seedInventory(paths);
		mkdirSync(join(paths.cwd, ".pi", "skills", "agent-browser"), { recursive: true });
		writeFileSync(join(paths.cwd, ".pi", "skills", "agent-browser", "SKILL.md"), "---\nname: agent-browser\ndescription: project override\n---\n");
		const inventory = collectInventory(paths.cwd, [], paths);
		const resolution = resolveTarget("agent-browser", inventory);

		expect(resolution.status).toBe("ambiguous");
		if (resolution.status !== "ambiguous") return;
		expect(resolution.candidates.map((candidate) => candidate.manager).sort()).toEqual(["loose-skill", "npx-skills"]);
	});

	test("returns ambiguous when npx and a plugin bundle both claim a member name", () => {
		const paths = fixturePaths();
		seedInventory(paths);
		writeJson(paths.npxSkillLockPath, {
			version: 3,
			skills: {
				lfg: {
					source: "example/lfg",
					sourceType: "github",
					sourceUrl: "https://github.com/example/lfg.git",
					skillPath: "skills/lfg/SKILL.md",
					skillFolderHash: "c1470a475a0472fceda2401ea6763708a91680a8",
				},
			},
		});
		mkdirSync(join(paths.agentsDir, "skills", "lfg"), { recursive: true });
		writeFileSync(join(paths.agentsDir, "skills", "lfg", "SKILL.md"), "---\nname: lfg\ndescription: test\n---\n");
		const inventory = collectInventory(paths.cwd, [], paths);
		const resolution = resolveTarget("lfg", inventory);

		expect(resolution.status).toBe("ambiguous");
		if (resolution.status !== "ambiguous") return;
		expect(resolution.candidates.map((candidate) => candidate.manager).sort()).toEqual(["npx-skills", "plugin-bundle"]);
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

describe("status freshness formatting", () => {
	test("does not use update action support as remote update availability", () => {
		const paths = fixturePaths();
		seedInventory(paths);
		const inventory = collectInventory(paths.cwd, [], paths);
		const resolution = resolveTarget("agent-browser", inventory);

		expect(resolution.status).toBe("resolved");
		if (resolution.status !== "resolved") return;
		expect(resolution.candidate.update).toBe("supported");
		const status = formatStatus(resolution, inventory);

		expect(status).toContain("Remote update: **Unknown**");
		expect(status).toContain("| Update | Supported |");
		expect(status).not.toContain("Update Available");
		expect(status).not.toContain("🟡");
		expect(status).not.toContain("✅");
		expect(status).not.toContain("Notes:");
	});

	test("renders update available only from freshness result", () => {
		const paths = fixturePaths();
		seedInventory(paths);
		const inventory = collectInventory(paths.cwd, [], paths);
		const resolution = resolveTarget("pi-subagents", inventory);
		const status = formatStatus(resolution, inventory, { status: "update-available", localVersion: "1.2.0", remoteVersion: "1.3.0" });

		expect(status).toContain("Remote update: **Update Available** (1.2.0 → 1.3.0)");
	});

	test("formats check unavailable neutrally", () => {
		const paths = fixturePaths();
		seedInventory(paths);
		const inventory = collectInventory(paths.cwd, [], paths);
		const resolution = resolveTarget("pi-subagents", inventory);
		const status = formatStatus(resolution, inventory, checkUnavailableFreshness("GitHub check timed out"));

		expect(status).toContain("Remote update: **Check unavailable**");
		expect(status).toContain("Reason: GitHub check timed out");
		expect(status).not.toContain("Update Available");
	});

	test("extracts strict GitHub semver evidence and rejects hash-only installs", () => {
		const gitPaths = fixturePaths();
		seedInventory(gitPaths);
		writeJson(gitPaths.userSettingsPath, { packages: ["git:https://github.com/example/pi-plugin.git#v1.2.3"] });
		let inventory = collectInventory(gitPaths.cwd, [], gitPaths);
		let resolution = resolveTarget("pi-plugin", inventory);
		expect(resolution.status).toBe("resolved");
		if (resolution.status !== "resolved") return;
		expect(freshnessEvidenceForCandidate(resolution.candidate)).toEqual({ repo: "example/pi-plugin", localVersion: "1.2.3" });

		const npxPaths = fixturePaths();
		seedInventory(npxPaths);
		inventory = collectInventory(npxPaths.cwd, [], npxPaths);
		resolution = resolveTarget("agent-browser", inventory);
		expect(resolution.status).toBe("resolved");
		if (resolution.status !== "resolved") return;
		expect(freshnessEvidenceForCandidate(resolution.candidate)).toEqual({ repo: "vercel-labs/agent-browser", skillPath: "skills/agent-browser/SKILL.md", localHash: "c1470a475a0472fceda2401ea6763708a91680a8" });
	});

	test("compares stable semver without coercing prereleases", () => {
		expect(compareStableSemver("v1.10.0", "1.9.9")).toBe(1);
		expect(compareStableSemver("1.2.3", "1.2.3")).toBe(0);
		expect(compareStableSemver("1.2.3-beta.1", "1.2.2")).toBeUndefined();
		expect(highestStableSemver(["latest", "v1.2.0", "1.10.0", "1.9.9-beta.1"])).toBe("1.10.0");
		expect(freshnessFromRemote({ repo: "example/repo", localVersion: "1.2.0" }, "1.3.0").status).toBe("update-available");
		expect(freshnessFromRemote({ repo: "example/repo", localVersion: "1.3.0" }, "1.3.0").status).toBe("up-to-date");
		expect(freshnessFromFolderHash("abc", "def").status).toBe("update-available");
		expect(freshnessFromFolderHash("abc", "abc").status).toBe("up-to-date");
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
				piPackage: { name: "private", source, scope: "user", filtered: false, identity: "git:example.com/org/private", pinned: false, sourceType: "git", updateSupported: false, removeSupported: true },
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

	test("redacts credentials from receipts and exec summaries", () => {
		const secretUrl = "https://user:password@example.com/repo.git?token=abc123";
		const receipt = makeReceipt(`Updated ${secretUrl}`, [`stdout: ${secretUrl}`]);
		const summary = summarizeExecResult(1, secretUrl, "");

		expect(receipt.title).not.toContain("password");
		expect(receipt.lines.join("\n")).not.toContain("abc123");
		expect(summary.join("\n")).not.toContain("password");
		expect(summary.join("\n")).toContain("token=…");
	});
});

describe("lifecycle lock", () => {
	test("does not remove an active lock just because it exists", async () => {
		const paths = fixturePaths();
		writeFileSync(paths.lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() - 60 * 60 * 1000 }));

		await expect(withLifecycleLock(paths, async () => "ran")).rejects.toThrow("Another skill lifecycle mutation appears to be running");
	});

	test("recovers old malformed locks", async () => {
		const paths = fixturePaths();
		writeFileSync(paths.lockPath, "");
		const old = new Date(Date.now() - 11 * 60 * 1000);
		utimesSync(paths.lockPath, old, old);

		await expect(withLifecycleLock(paths, async () => "ran")).resolves.toBe("ran");
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
