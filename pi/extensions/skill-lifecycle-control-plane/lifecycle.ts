import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

export type Confidence = "exact" | "inferred" | "ambiguous" | "unsupported";
export type Manager = "compound-plugin" | "pi-package" | "npx-skills" | "runtime-command" | "loose-skill";
export type TargetKind = "bundle" | "bundle-member" | "pi-package" | "external-skill" | "runtime-command" | "loose-skill";
export type MutationKind = "update" | "remove";
export type ActionSupport = "supported" | "guidance-only" | "unsupported";
export type ApplyStatus = "success" | "failed" | "cancelled";

export interface PathsConfig {
	cwd: string;
	agentDir: string;
	agentsDir: string;
	compoundManifestPath: string;
	npxSkillLockPath: string;
	userSettingsPath: string;
	projectSettingsPath: string;
	lockPath: string;
}

export interface CompoundManifest {
	pluginName: string;
	skills: string[];
	agents: string[];
	path: string;
	raw: string;
}

export interface NpxSkill {
	name: string;
	path: string;
	source?: string;
	sourceUrl?: string;
	pluginName?: string;
}

export interface PiPackage {
	name: string;
	source: string;
	scope: "user" | "project";
	filtered: boolean;
}

export interface RuntimeCommand {
	name: string;
	source: string;
	path?: string;
	scope?: string;
	origin?: string;
	baseDir?: string;
}

export interface LooseSkill {
	name: string;
	path: string;
	scope: "pi-user" | "agents-user" | "pi-project";
}

export interface Inventory {
	paths: PathsConfig;
	compound?: CompoundManifest;
	npxSkills: NpxSkill[];
	piPackages: PiPackage[];
	runtimeCommands: RuntimeCommand[];
	looseSkills: LooseSkill[];
	warnings: string[];
}

export interface ResourceSummary {
	label: string;
	path?: string;
	count?: number;
	manager?: Manager;
}

export interface Candidate {
	kind: TargetKind;
	manager: Manager;
	confidence: Confidence;
	canonicalTarget: string;
	displayName: string;
	source?: string;
	scope?: string;
	resources: ResourceSummary[];
	notes: string[];
	update: ActionSupport;
	remove: ActionSupport;
	piPackage?: PiPackage;
	npxSkill?: NpxSkill;
}

export type Resolution =
	| { status: "resolved"; candidate: Candidate }
	| { status: "ambiguous"; target: string; candidates: Candidate[] }
	| { status: "unsupported"; target: string; suggestions: Candidate[]; reason: string };

export interface ActionPlan {
	kind: MutationKind;
	title: string;
	candidate: Candidate;
	supported: boolean;
	guidanceOnly: boolean;
	steps: string[];
	warnings: string[];
	command?: { command: string; args: string[]; display: string };
	requiresReload: boolean;
}

export interface ApplyResult {
	status: ApplyStatus;
	title: string;
	changed: boolean;
	lines: string[];
}

export interface LifecycleReceipt {
	id: string;
	ts: number;
	title: string;
	lines: string[];
}

interface JsonObject {
	[key: string]: unknown;
}

const COMPOUND_PACKAGE = "compound-engineering";
const COMPOUND_COMMAND = {
	command: "bunx",
	args: ["@every-env/compound-plugin", "install", COMPOUND_PACKAGE, "--to", "pi"],
};

export function defaultPaths(cwd: string): PathsConfig {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	const agentsDir = join(homedir(), ".agents");
	return {
		cwd,
		agentDir,
		agentsDir,
		compoundManifestPath: join(agentDir, COMPOUND_PACKAGE, "install-manifest.json"),
		npxSkillLockPath: join(agentsDir, ".skill-lock.json"),
		userSettingsPath: join(agentDir, "settings.json"),
		projectSettingsPath: join(cwd, ".pi", "settings.json"),
		lockPath: join(tmpdir(), "pi-skill-lifecycle-control-plane.lock"),
	};
}

export function normalizeTarget(input: string): string {
	let value = input.trim();
	if (value.startsWith("/")) value = value.slice(1);
	if (value.startsWith("skill:")) value = value.slice("skill:".length);
	return value.trim().toLowerCase();
}

export function displayPath(path: string): string {
	const home = homedir();
	if (path === home) return "~";
	if (path.startsWith(home + sep)) return `~${path.slice(home.length)}`;
	return path;
}

export function redactDisplay(value: string): string {
	let redacted = redactLine(value)
		.replace(/(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, "$1…:…@")
		.replace(/(git(?:\+https)?|ssh):\/\/([^\s/@:]+):([^\s/@]+)@/gi, "$1://…:…@")
		.replace(/([?&](?:access_token|auth_token|token|password|passwd|secret|key)=)[^&\s]+/gi, "$1…")
		.replace(/(\/\/)[^\s/@:]+:[^\s/@]+@/g, "$1…:…@");
	if (redacted.startsWith("git@")) redacted = redacted.replace(/git@([^:]+):/, "git@***:");
	return redacted;
}

function displaySafePath(path: string): string {
	return redactDisplay(displayPath(path));
}

export function collectInventory(cwd: string, commands: SlashCommandInfo[] = [], paths = defaultPaths(cwd)): Inventory {
	const warnings: string[] = [];
	const compound = readCompoundManifest(paths.compoundManifestPath, warnings);
	const npxSkills = readNpxSkillLock(paths.npxSkillLockPath, paths.agentsDir, warnings);
	const piPackages = readPiPackages(paths, warnings);
	const runtimeCommands = commands.map((command) => ({
		name: command.name,
		source: command.source,
		path: command.sourceInfo?.path,
		scope: command.sourceInfo?.scope,
		origin: command.sourceInfo?.origin,
		baseDir: command.sourceInfo?.baseDir,
	}));
	const looseSkills = collectLooseSkills(paths, compound, npxSkills);

	return { paths, compound, npxSkills, piPackages, runtimeCommands, looseSkills, warnings };
}

export function resolveTarget(input: string, inventory: Inventory): Resolution {
	const target = normalizeTarget(input);
	if (!target) {
		return { status: "unsupported", target, suggestions: discoverableCandidates(inventory), reason: "No target provided." };
	}

	const exact = exactCandidates(target, inventory);
	const distinctExact = dedupeCandidates(exact);
	if (distinctExact.length === 1) return { status: "resolved", candidate: distinctExact[0] };
	if (distinctExact.length > 1) return { status: "ambiguous", target, candidates: distinctExact };

	const inferred = inferredCandidates(target, inventory);
	const distinctInferred = dedupeCandidates(inferred);
	if (distinctInferred.length === 1) return { status: "resolved", candidate: distinctInferred[0] };
	if (distinctInferred.length > 1) return { status: "ambiguous", target, candidates: distinctInferred };

	const suggestions = fuzzySuggestions(target, discoverableCandidates(inventory));
	return { status: "unsupported", target, suggestions, reason: `No lifecycle target matched "${input.trim()}".` };
}

export function buildUpdatePlan(resolution: Resolution): ActionPlan {
	if (resolution.status !== "resolved") return unsupportedPlan("update", resolution);
	const candidate = resolution.candidate;
	if (candidate.kind !== "bundle" || candidate.canonicalTarget !== COMPOUND_PACKAGE) {
		return {
			kind: "update",
			title: `Update ${candidate.displayName}`,
			candidate,
			supported: false,
			guidanceOnly: true,
			steps: [`V1에서 mutating update는 \`${COMPOUND_PACKAGE}\`만 지원합니다.`, `이 target은 status/guidance-only입니다.`],
			warnings: candidate.notes,
			requiresReload: false,
		};
	}

	return {
		kind: "update",
		title: `Update ${COMPOUND_PACKAGE}`,
		candidate,
		supported: true,
		guidanceOnly: false,
		steps: [
			"Compound manifest와 관련 skills/agents 상태를 읽습니다.",
			"신뢰 가능한 updater 실행 경로를 확인합니다.",
			"확인 후 Compound installer를 sync/update-by-reinstall로 실행합니다.",
			"실행 후 manifest/resources를 다시 읽고 결과를 요약합니다.",
			"Pi resources가 바뀌었을 수 있으므로 reload receipt를 남기고 runtime을 refresh합니다.",
		],
		warnings: ["이 명령은 외부 package code를 실행합니다. 실행 직전 high-risk confirmation을 한 번 더 요구합니다."],
		command: {
			command: COMPOUND_COMMAND.command,
			args: [...COMPOUND_COMMAND.args],
			display: `${COMPOUND_COMMAND.command} ${COMPOUND_COMMAND.args.join(" ")}`,
		},
		requiresReload: true,
	};
}

export function buildRemovePlan(resolution: Resolution): ActionPlan {
	if (resolution.status !== "resolved") return unsupportedPlan("remove", resolution);
	const candidate = resolution.candidate;

	if (candidate.kind === "pi-package" && candidate.piPackage) {
		const args = ["remove", candidate.piPackage.source];
		if (candidate.piPackage.scope === "project") args.push("-l");
		return {
			kind: "remove",
			title: `Remove ${candidate.displayName}`,
			candidate,
			supported: true,
			guidanceOnly: false,
			steps: [
				"Pi package settings에서 package source를 제거합니다.",
				"Pi package manager가 관리하는 resources를 unload할 수 있도록 reload receipt를 남깁니다.",
			],
			warnings: ["이 작업은 Pi package를 제거합니다. 현재 session capability가 줄어들 수 있습니다."],
			command: { command: "pi", args, display: `pi ${args.join(" ")}` },
			requiresReload: true,
		};
	}

	return {
		kind: "remove",
		title: `Remove ${candidate.displayName}`,
		candidate,
		supported: false,
		guidanceOnly: true,
		steps: removeGuidance(candidate),
		warnings: candidate.notes,
		requiresReload: false,
	};
}

export function formatStatus(resolution: Resolution, inventory: Inventory): string {
	if (resolution.status === "ambiguous") {
		return [
			`## Skill lifecycle status: ambiguous target \`${resolution.target}\``,
			"",
			"Multiple candidates matched. No mutation will run until the target is disambiguated.",
			"",
			...resolution.candidates.flatMap((candidate) => formatCandidate(candidate).map((line) => `- ${line}`)),
		].join("\n");
	}

	if (resolution.status === "unsupported") {
		const lines = [`## Skill lifecycle status: unsupported target`, "", resolution.reason];
		if (resolution.suggestions.length > 0) {
			lines.push("", "Possible targets:");
			for (const suggestion of resolution.suggestions.slice(0, 8)) {
				lines.push(`- \`${suggestion.canonicalTarget}\` — ${suggestion.manager} (${suggestion.confidence})`);
			}
		} else {
			lines.push("", "Known top-level targets:", ...completionItems(inventory).slice(0, 12).map((item) => `- \`${item.value}\` — ${item.description ?? item.label}`));
		}
		return lines.join("\n");
	}

	const candidate = resolution.candidate;
	const lines = [`## Skill lifecycle status: \`${candidate.displayName}\``, "", ...formatCandidate(candidate)];
	if (inventory.warnings.length > 0) {
		lines.push("", "Warnings:", ...inventory.warnings.map((warning) => `- ${warning}`));
	}
	return lines.join("\n");
}

export function formatPlan(plan: ActionPlan): string {
	const lines = [`## ${redactDisplay(plan.title)}`, "", `Target: \`${redactDisplay(plan.candidate.displayName)}\``, `Manager: ${plan.candidate.manager}`, `Support: ${plan.supported ? "supported" : plan.guidanceOnly ? "guidance-only" : "unsupported"}`];
	if (plan.command) lines.push(`Command: \`${redactDisplay(plan.command.display)}\``);
	lines.push("", "Plan:", ...plan.steps.map((step) => `- ${redactDisplay(step)}`));
	if (plan.warnings.length > 0) lines.push("", "Warnings:", ...plan.warnings.map((warning) => `- ${redactDisplay(warning)}`));
	return lines.join("\n");
}

export function completionItems(inventory: Inventory): AutocompleteItem[] {
	return dedupeCandidates(discoverableCandidates(inventory))
		.map((candidate) => ({
			value: candidate.canonicalTarget,
			label: candidate.canonicalTarget,
			description: `${candidate.manager} · update:${candidate.update} remove:${candidate.remove}`,
		}))
		.sort((a, b) => a.value.localeCompare(b.value));
}

export function filterCompletions(prefix: string, inventory: Inventory): AutocompleteItem[] | null {
	const normalizedPrefix = normalizeTarget(prefix);
	const items = completionItems(inventory).filter((item) => item.value.toLowerCase().includes(normalizedPrefix));
	return items.length > 0 ? items.slice(0, 20) : null;
}

export function makeReceipt(title: string, lines: string[]): LifecycleReceipt {
	return { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, ts: Date.now(), title, lines: lines.map(redactLine).slice(0, 20) };
}

export function formatReceipt(receipt: LifecycleReceipt): string {
	return [`## ${receipt.title}`, "", ...receipt.lines.map((line) => `- ${line}`)].join("\n");
}

export function readRecentReceipt(entries: unknown[], maxAgeMs = 5 * 60 * 1000): LifecycleReceipt | undefined {
	for (const entry of [...entries].reverse()) {
		const item = entry as { type?: unknown; customType?: unknown; data?: unknown };
		if (item.type !== "custom" || item.customType !== "skill-lifecycle-receipt") continue;
		const receipt = item.data as LifecycleReceipt | undefined;
		if (!receipt?.id || typeof receipt.ts !== "number" || !Array.isArray(receipt.lines)) continue;
		if (Date.now() - receipt.ts > maxAgeMs) return undefined;
		return receipt;
	}
	return undefined;
}

export async function withLifecycleLock<T>(paths: PathsConfig, fn: () => Promise<T>): Promise<T> {
	const release = acquireLock(paths.lockPath);
	try {
		return await fn();
	} finally {
		release();
	}
}

export function isSafeRemovablePath(targetPath: string, allowedRoots: string[]): { safe: boolean; reason?: string } {
	try {
		if (!existsSync(targetPath)) return { safe: false, reason: "path does not exist" };
		const stat = lstatSync(targetPath);
		if (stat.isSymbolicLink()) return { safe: false, reason: "refusing to remove symlink" };
		const realTarget = realpathSync(targetPath);
		const realRoots = allowedRoots.filter(existsSync).map((root) => realpathSync(root));
		for (const root of realRoots) {
			if (realTarget === root || realTarget.startsWith(root + sep)) return { safe: true };
		}
		return { safe: false, reason: "path is outside allowed Pi resource roots" };
	} catch (error) {
		return { safe: false, reason: error instanceof Error ? error.message : String(error) };
	}
}

export function summarizeExecResult(code: number, stdout: string, stderr: string): string[] {
	const lines = [`exit code ${code}`];
	const stdoutLine = firstNonEmptyLine(stdout);
	const stderrLine = firstNonEmptyLine(stderr);
	if (stdoutLine) lines.push(`stdout: ${redactLine(stdoutLine)}`);
	if (stderrLine) lines.push(`stderr: ${redactLine(stderrLine)}`);
	return lines;
}

export function readCompoundSummary(paths: PathsConfig): { exists: boolean; raw?: string; skills: number; agents: number } {
	const manifest = readCompoundManifest(paths.compoundManifestPath, []);
	return {
		exists: Boolean(manifest),
		raw: manifest?.raw,
		skills: manifest?.skills.length ?? 0,
		agents: manifest?.agents.length ?? 0,
	};
}

function readCompoundManifest(path: string, warnings: string[]): CompoundManifest | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as { pluginName?: unknown; skills?: unknown; agents?: unknown };
		return {
			pluginName: typeof parsed.pluginName === "string" ? parsed.pluginName : COMPOUND_PACKAGE,
			skills: Array.isArray(parsed.skills) ? parsed.skills.filter((item): item is string => typeof item === "string") : [],
			agents: Array.isArray(parsed.agents) ? parsed.agents.filter((item): item is string => typeof item === "string") : [],
			path,
			raw,
		};
	} catch (error) {
		warnings.push(`Failed to read Compound manifest at ${displayPath(path)}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

function readNpxSkillLock(path: string, agentsDir: string, warnings: string[]): NpxSkill[] {
	if (!existsSync(path)) return [];
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { skills?: Record<string, JsonObject> };
		return Object.entries(parsed.skills ?? {}).map(([name, info]) => ({
			name,
			path: join(agentsDir, "skills", name),
			source: typeof info.source === "string" ? info.source : undefined,
			sourceUrl: typeof info.sourceUrl === "string" ? info.sourceUrl : undefined,
			pluginName: typeof info.pluginName === "string" ? info.pluginName : undefined,
		}));
	} catch (error) {
		warnings.push(`Failed to read npx skills lock at ${displayPath(path)}: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}

function readPiPackages(paths: PathsConfig, warnings: string[]): PiPackage[] {
	return [...readPackagesFromSettings(paths.userSettingsPath, "user", warnings), ...readPackagesFromSettings(paths.projectSettingsPath, "project", warnings)];
}

function readPackagesFromSettings(path: string, scope: "user" | "project", warnings: string[]): PiPackage[] {
	if (!existsSync(path)) return [];
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { packages?: unknown[] };
		return (parsed.packages ?? []).flatMap((entry) => {
			const source = typeof entry === "string" ? entry : entry && typeof entry === "object" && typeof (entry as { source?: unknown }).source === "string" ? (entry as { source: string }).source : undefined;
			if (!source) return [];
			return [{ name: packageNameFromSource(source), source, scope, filtered: typeof entry === "object" }];
		});
	} catch (error) {
		warnings.push(`Failed to read Pi settings at ${displayPath(path)}: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}

function collectLooseSkills(paths: PathsConfig, compound: CompoundManifest | undefined, npxSkills: NpxSkill[]): LooseSkill[] {
	const compoundSkillNames = new Set(compound?.skills ?? []);
	const npxSkillNames = new Set(npxSkills.map((skill) => skill.name));
	const roots: Array<{ path: string; scope: LooseSkill["scope"] }> = [
		{ path: join(paths.agentDir, "skills"), scope: "pi-user" },
		{ path: join(paths.agentsDir, "skills"), scope: "agents-user" },
		{ path: join(paths.cwd, ".pi", "skills"), scope: "pi-project" },
	];
	const loose: LooseSkill[] = [];
	for (const root of roots) {
		if (!existsSync(root.path)) continue;
		try {
			for (const name of readDirNames(root.path)) {
				if (compoundSkillNames.has(name) || npxSkillNames.has(name)) continue;
				const skillPath = join(root.path, name);
				if (existsSync(join(skillPath, "SKILL.md"))) loose.push({ name, path: skillPath, scope: root.scope });
			}
		} catch {
			// Best-effort fallback only.
		}
	}
	return loose;
}

function readDirNames(path: string): string[] {
	return readdirSync(path, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
}

function exactCandidates(target: string, inventory: Inventory): Candidate[] {
	const candidates: Candidate[] = [];
	if (inventory.compound && normalizeTarget(inventory.compound.pluginName) === target) candidates.push(compoundBundleCandidate(inventory.compound));
	for (const pkg of inventory.piPackages) {
		if (normalizeTarget(pkg.name) === target || normalizeTarget(pkg.source) === target) candidates.push(piPackageCandidate(pkg));
	}
	for (const skill of inventory.npxSkills) {
		if (normalizeTarget(skill.name) === target) candidates.push(npxSkillCandidate(skill));
	}
	for (const loose of inventory.looseSkills) {
		if (normalizeTarget(loose.name) === target) candidates.push(looseSkillCandidate(loose));
	}
	for (const command of inventory.runtimeCommands) {
		const commandTarget = normalizeTarget(command.name);
		if (commandTarget === target && !isCompoundMemberTarget(target, inventory) && !candidateAlreadyExplainsCommand(command, candidates)) candidates.push(runtimeCommandCandidate(command));
	}
	return candidates;
}

function inferredCandidates(target: string, inventory: Inventory): Candidate[] {
	const candidates: Candidate[] = [];
	if (inventory.compound) {
		const skill = inventory.compound.skills.find((name) => normalizeTarget(name) === target);
		const agent = inventory.compound.agents.find((name) => normalizeTarget(name.replace(/\.md$/, "")) === target);
		if (skill || agent) candidates.push(compoundMemberCandidate(inventory.compound, skill ?? agent ?? target));
	}
	for (const command of inventory.runtimeCommands) {
		const commandName = normalizeTarget(command.name.replace(/^skill:/, ""));
		if (commandName === target && !isCompoundMemberTarget(target, inventory) && !candidateAlreadyExplainsCommand(command, candidates)) candidates.push(runtimeCommandCandidate(command, "inferred"));
	}
	return candidates;
}

function discoverableCandidates(inventory: Inventory): Candidate[] {
	const candidates: Candidate[] = [];
	if (inventory.compound) {
		candidates.push(compoundBundleCandidate(inventory.compound));
		for (const skill of inventory.compound.skills) candidates.push(compoundMemberCandidate(inventory.compound, skill));
	}
	for (const pkg of inventory.piPackages) candidates.push(piPackageCandidate(pkg));
	for (const skill of inventory.npxSkills) candidates.push(npxSkillCandidate(skill));
	for (const loose of inventory.looseSkills) candidates.push(looseSkillCandidate(loose));
	return candidates;
}

function compoundBundleCandidate(manifest: CompoundManifest): Candidate {
	return {
		kind: "bundle",
		manager: "compound-plugin",
		confidence: "exact",
		canonicalTarget: manifest.pluginName || COMPOUND_PACKAGE,
		displayName: manifest.pluginName || COMPOUND_PACKAGE,
		source: manifest.path,
		resources: [
			{ label: "skills", count: manifest.skills.length, manager: "compound-plugin" },
			{ label: "agents", count: manifest.agents.length, manager: "compound-plugin" },
			{ label: "manifest", path: manifest.path, manager: "compound-plugin" },
		],
		notes: ["Compound bundle removal is guidance-only in v1."],
		update: "supported",
		remove: "guidance-only",
	};
}

function compoundMemberCandidate(manifest: CompoundManifest, member: string): Candidate {
	return {
		kind: "bundle-member",
		manager: "compound-plugin",
		confidence: "inferred",
		canonicalTarget: manifest.pluginName || COMPOUND_PACKAGE,
		displayName: member.replace(/\.md$/, ""),
		source: manifest.path,
		resources: [{ label: "owning bundle", path: manifest.path, manager: "compound-plugin" }],
		notes: [`This target is owned by \`${manifest.pluginName || COMPOUND_PACKAGE}\`. Use the canonical bundle target for mutation.`],
		update: "guidance-only",
		remove: "guidance-only",
	};
}

function piPackageCandidate(pkg: PiPackage): Candidate {
	return {
		kind: "pi-package",
		manager: "pi-package",
		confidence: "exact",
		canonicalTarget: pkg.name,
		displayName: pkg.name,
		source: pkg.source,
		scope: pkg.scope,
		resources: [{ label: "package source", path: pkg.source, manager: "pi-package" }],
		notes: ["Pi package update is guidance-only in v1; package remove is supported after confirmation."],
		update: "guidance-only",
		remove: "supported",
		piPackage: pkg,
	};
}

function npxSkillCandidate(skill: NpxSkill): Candidate {
	return {
		kind: "external-skill",
		manager: "npx-skills",
		confidence: "exact",
		canonicalTarget: skill.name,
		displayName: skill.name,
		source: skill.sourceUrl ?? skill.source,
		resources: [{ label: "skill", path: skill.path, manager: "npx-skills" }],
		notes: ["Pi also loads ~/.agents/skills directly; v1 will not delete or purge this external skill without a verified Pi-visibility-only mechanism."],
		update: "guidance-only",
		remove: "guidance-only",
		npxSkill: skill,
	};
}

function looseSkillCandidate(skill: LooseSkill): Candidate {
	return {
		kind: "loose-skill",
		manager: "loose-skill",
		confidence: "exact",
		canonicalTarget: skill.name,
		displayName: skill.name,
		scope: skill.scope,
		resources: [{ label: "skill", path: skill.path, manager: "loose-skill" }],
		notes: ["Loose skill provenance learning is deferred; mutation is unsupported in v1."],
		update: "unsupported",
		remove: "unsupported",
	};
}

function runtimeCommandCandidate(command: RuntimeCommand, confidence: Confidence = "exact"): Candidate {
	return {
		kind: "runtime-command",
		manager: "runtime-command",
		confidence,
		canonicalTarget: command.name,
		displayName: command.name,
		source: command.source,
		scope: command.scope,
		resources: [{ label: "command", path: command.path, manager: "runtime-command" }],
		notes: ["Runtime command provenance is informational; mutation is unsupported unless another manager owns it."],
		update: "unsupported",
		remove: "unsupported",
	};
}

function candidateAlreadyExplainsCommand(command: RuntimeCommand, candidates: Candidate[]): boolean {
	if (!command.path) return false;
	return candidates.some((candidate) => candidate.resources.some((resource) => resource.path && pathContains(resource.path, command.path!)));
}

function isCompoundMemberTarget(target: string, inventory: Inventory): boolean {
	return Boolean(inventory.compound && (
		inventory.compound.skills.some((name) => normalizeTarget(name) === target) ||
		inventory.compound.agents.some((name) => normalizeTarget(name.replace(/\.md$/, "")) === target)
	));
}

function pathContains(resourcePath: string, commandPath: string): boolean {
	const root = resourceRoot(resourcePath);
	if (!root) return false;
	const child = canonicalPath(commandPath);
	return Boolean(child && (child === root || child.startsWith(root + sep)));
}

function resourceRoot(path: string): string | undefined {
	if (!isPathLike(path)) return undefined;
	try {
		if (existsSync(path)) {
			const stat = lstatSync(path);
			return stat.isDirectory() ? realpathSync(path) : realpathSync(dirname(path));
		}
		return canonicalPath(dirname(path));
	} catch {
		return undefined;
	}
}

function canonicalPath(path: string): string | undefined {
	if (!isPathLike(path)) return undefined;
	try {
		return existsSync(path) ? realpathSync(path) : resolve(path);
	} catch {
		return undefined;
	}
}

function isPathLike(path: string): boolean {
	return isAbsolute(path) || path.startsWith("~" + sep) || path.startsWith("." + sep) || path.startsWith(".." + sep);
}

function dedupeCandidates(candidates: Candidate[]): Candidate[] {
	const seen = new Set<string>();
	return candidates.filter((candidate) => {
		const key = `${candidate.manager}:${candidate.kind}:${candidate.canonicalTarget}:${candidate.source ?? ""}:${candidate.scope ?? ""}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function fuzzySuggestions(target: string, candidates: Candidate[]): Candidate[] {
	if (!target) return candidates.slice(0, 8);
	return candidates.filter((candidate) => candidate.canonicalTarget.includes(target) || candidate.displayName.includes(target)).slice(0, 8);
}

function unsupportedPlan(kind: MutationKind, resolution: Exclude<Resolution, { status: "resolved" }>): ActionPlan {
	const title = `${kind === "update" ? "Update" : "Remove"} ${resolution.target || "target"}`;
	const placeholder = runtimeCommandCandidate({ name: resolution.target || "unknown", source: "unknown" }, "unsupported");
	return {
		kind,
		title,
		candidate: placeholder,
		supported: false,
		guidanceOnly: true,
		steps: [resolution.status === "ambiguous" ? "Target is ambiguous. Resolve to one candidate first." : resolution.reason],
		warnings: [],
		requiresReload: false,
	};
}

function removeGuidance(candidate: Candidate): string[] {
	if (candidate.kind === "external-skill") {
		return [
			"이 target은 external `npx skills` resource입니다.",
			"Pi가 `~/.agents/skills`를 직접 load하므로 단순 binding 제거만으로 Pi visibility가 사라진다고 가정하지 않습니다.",
			"V1에서는 verified Pi-visibility-only mechanism이 없으면 삭제하지 않고 guidance-only로 종료합니다.",
		];
	}
	if (candidate.kind === "bundle" || candidate.kind === "bundle-member") {
		return ["Compound bundle/member removal은 v1에서 guidance-only입니다.", "Compound full removal은 별도 purge/restore 설계가 필요합니다."];
	}
	return ["This target has no supported remove adapter in v1."];
}

function formatCandidate(candidate: Candidate): string[] {
	const lines = [
		`Identity: \`${redactDisplay(candidate.displayName)}\``,
		`Canonical target: \`${redactDisplay(candidate.canonicalTarget)}\``,
		`Manager: ${candidate.manager}`,
		`Confidence: ${candidate.confidence}`,
		`Actions: status=supported, update=${candidate.update}, remove=${candidate.remove}`,
	];
	if (candidate.source) lines.push(`Source: ${displaySafePath(candidate.source)}`);
	if (candidate.scope) lines.push(`Scope: ${candidate.scope}`);
	if (candidate.resources.length > 0) {
		lines.push("Resources:");
		for (const resource of candidate.resources) {
			const detail = resource.count !== undefined ? `${resource.count}` : resource.path ? displaySafePath(resource.path) : "";
			lines.push(`  - ${redactDisplay(resource.label)}${detail ? `: ${detail}` : ""}`);
		}
	}
	if (candidate.notes.length > 0) {
		lines.push("Notes:");
		lines.push(...candidate.notes.map((note) => `  - ${redactDisplay(note)}`));
	}
	return lines;
}

function packageNameFromSource(source: string): string {
	const withoutPrefix = source.replace(/^npm:/, "").replace(/^git:/, "");
	if (source.startsWith("npm:")) return stripNpmVersion(withoutPrefix);
	const urlMatch = withoutPrefix.match(/([^/@:]+\/[^/@]+?)(?:\.git)?(?:@[^/]+)?$/);
	if (urlMatch) return urlMatch[1].split("/").pop() ?? withoutPrefix;
	return withoutPrefix.replace(/@[^@/]+$/, "");
}

function stripNpmVersion(spec: string): string {
	if (spec.startsWith("@")) {
		const secondAt = spec.indexOf("@", 1);
		return secondAt === -1 ? spec : spec.slice(0, secondAt);
	}
	return spec.split("@")[0];
}

function firstNonEmptyLine(text: string): string | undefined {
	return text.split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, 240);
}

function redactLine(line: string): string {
	return line
		.replace(/sk-[A-Za-z0-9_-]+/g, "sk-…")
		.replace(/([A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*=)[^\s]+/gi, "$1…")
		.replace(/([A-Za-z0-9_]*KEY[A-Za-z0-9_]*=)[^\s]+/gi, "$1…")
		.slice(0, 240);
}

function acquireLock(path: string): () => void {
	mkdirSync(dirname(path), { recursive: true });
	try {
		const fd = openSync(path, "wx");
		writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
		closeSync(fd);
	} catch (error) {
		if ((error as { code?: string }).code === "EEXIST") {
			try {
				const stat = lstatSync(path);
				if (Date.now() - stat.mtimeMs > 15 * 60 * 1000) {
					unlinkSync(path);
					return acquireLock(path);
				}
			} catch {
				// Fall through to useful error.
			}
			throw new Error("Another skill lifecycle mutation appears to be running. Try again after it completes.");
		}
		throw error;
	}
	return () => {
		try {
			rmSync(path, { force: true });
		} catch {
			// Best effort cleanup.
		}
	};
}
