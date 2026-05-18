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
export type NpxRemoveMode = "pi-visibility" | "global";

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
	sourceType?: string;
	sourceUrl?: string;
	skillPath?: string;
	skillFolderHash?: string;
	pluginName?: string;
	lockVersion?: number;
	verified: boolean;
	verificationIssues: string[];
}

export interface PiPackage {
	name: string;
	source: string;
	scope: "user" | "project";
	filtered: boolean;
	identity: string;
	pinned: boolean;
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
	revalidateTarget?: string;
	npxRemoveMode?: NpxRemoveMode;
}

export interface ApplyResult {
	status: ApplyStatus;
	title: string;
	changed: boolean;
	requiresReload?: boolean;
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
const SUPPORTED_NPX_LOCK_VERSION = 3;
export const SUPPORTED_NPX_SKILLS_CLI_VERSION = "1.5.7";
const SUPPORTED_NPX_SKILLS_CLI_PACKAGE = `skills@${SUPPORTED_NPX_SKILLS_CLI_VERSION}`;
const SAFE_NPX_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GITHUB_SOURCE_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GIT_TREE_SHA_RE = /^[a-f0-9]{40}$/;

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
		lockPath: join(tmpdir(), "pi-skill-manager.lock"),
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

	if ((candidate.kind === "bundle" || candidate.kind === "bundle-member") && candidate.canonicalTarget === COMPOUND_PACKAGE) {
		const memberUpdate = candidate.kind === "bundle-member";
		return {
			kind: "update",
			title: memberUpdate ? `Update ${candidate.displayName} via ${COMPOUND_PACKAGE}` : `Update ${COMPOUND_PACKAGE}`,
			candidate,
			supported: true,
			guidanceOnly: false,
			steps: [
				...(memberUpdate ? [`\`${candidate.displayName}\` is owned by \`${COMPOUND_PACKAGE}\`; updating it refreshes the whole owning bundle.`] : []),
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
			revalidateTarget: candidate.kind === "bundle-member" ? candidate.displayName : candidate.canonicalTarget,
		};
	}

	if (candidate.kind === "external-skill" && candidate.npxSkill?.verified) {
		const args = ["--yes", SUPPORTED_NPX_SKILLS_CLI_PACKAGE, "update", candidate.npxSkill.name, "-g", "-y"];
		return {
			kind: "update",
			title: `Update ${candidate.displayName}`,
			candidate,
			supported: true,
			guidanceOnly: false,
			steps: [
				"Safe global npx skills lock metadata and installed path are required before this plan is built.",
				`Before mutation, run the exact \`${SUPPORTED_NPX_SKILLS_CLI_PACKAGE}\` CLI version check.`,
				"Run a single-skill npx skills update with non-interactive arguments.",
				"Reload Pi after a successful update because resource content can change without settings/count changes.",
			],
			warnings: ["This runs external package-manager code. Proceed only if you trust this skill source and local credentials exposure risk."],
			command: { command: "npx", args, display: `npx ${args.join(" ")}` },
			requiresReload: true,
			revalidateTarget: candidate.displayName,
		};
	}

	return {
		kind: "update",
		title: `Update ${candidate.displayName}`,
		candidate,
		supported: false,
		guidanceOnly: true,
		steps: updateGuidance(candidate),
		warnings: candidate.notes,
		requiresReload: false,
	};
}

export function buildRemovePlan(resolution: Resolution, options: { npxRemoveMode?: NpxRemoveMode } = {}): ActionPlan {
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
			revalidateTarget: candidate.source ?? candidate.displayName,
		};
	}

	if (candidate.kind === "external-skill" && candidate.npxSkill?.verified) {
		if (options.npxRemoveMode === "global") {
			return {
				kind: "remove",
				title: `Remove ${candidate.displayName} globally`,
				candidate,
				supported: false,
				guidanceOnly: true,
				steps: [
					"Whole-global npx removal remains guidance-only until the exact `skills` CLI contract and provenance binding are proven.",
					"Use `npx skills remove` manually only if you intend to remove the shared global skill for all agents.",
				],
				warnings: ["Automatic global removal is blocked because it can affect other agents that share ~/.agents/skills."],
				requiresReload: false,
				npxRemoveMode: "global",
			};
		}

		return {
			kind: "remove",
			title: `Hide ${candidate.displayName} from Pi`,
			candidate,
			supported: true,
			guidanceOnly: false,
			steps: [
				"Safe local npx skill name/path metadata are required before this plan is built.",
				"Add an idempotent user-scope Pi skill override to hide this npx skill from Pi.",
				"Do not delete the shared global skill directory or npx lock entry.",
				"Reload Pi so the current session reflects changed skill visibility.",
			],
			warnings: ["This hides the skill from Pi only. Other agents may still use the global skill, and another Pi-visible source with the same command name may remain visible."],
			requiresReload: true,
			revalidateTarget: candidate.displayName,
			npxRemoveMode: "pi-visibility",
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
	const seen = new Set<string>();
	return discoverableCandidates(inventory)
		.map((candidate) => {
			const value = candidate.kind === "bundle-member" ? candidate.displayName : candidate.canonicalTarget;
			return {
				value,
				label: value,
				description: `${candidate.manager} · update:${candidate.update} remove:${candidate.remove}`,
			};
		})
		.filter((item) => {
			const key = item.value.toLowerCase();
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.sort((a, b) => a.value.localeCompare(b.value));
}

export function filterCompletions(prefix: string, inventory: Inventory): AutocompleteItem[] | null {
	const normalizedPrefix = normalizeTarget(prefix);
	const items = completionItems(inventory).filter((item) => item.value.toLowerCase().includes(normalizedPrefix));
	return items.length > 0 ? items.slice(0, 20) : null;
}

export function makeReceipt(title: string, lines: string[]): LifecycleReceipt {
	return { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, ts: Date.now(), title: redactDisplay(title), lines: lines.map(redactDisplay).slice(0, 20) };
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
	if (stdoutLine) lines.push(`stdout: ${redactDisplay(stdoutLine)}`);
	if (stderrLine) lines.push(`stderr: ${redactDisplay(stderrLine)}`);
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
		const lockIssues = verifyNpxLockFile(path);
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; skills?: Record<string, JsonObject> };
		const lockVersion = typeof parsed.version === "number" ? parsed.version : undefined;
		return Object.entries(parsed.skills ?? {}).map(([name, info]) => {
			const skillPath = join(agentsDir, "skills", name);
			const source = typeof info.source === "string" ? info.source : undefined;
			const sourceType = typeof info.sourceType === "string" ? info.sourceType : undefined;
			const sourceUrl = typeof info.sourceUrl === "string" ? info.sourceUrl : undefined;
			const lockedSkillPath = typeof info.skillPath === "string" ? info.skillPath : undefined;
			const skillFolderHash = typeof info.skillFolderHash === "string" ? info.skillFolderHash : undefined;
			const verificationIssues = verifyNpxSkill(name, skillPath, agentsDir, lockVersion, { source, sourceType, sourceUrl, skillPath: lockedSkillPath, skillFolderHash }, lockIssues);
			return {
				name,
				path: skillPath,
				source,
				sourceType,
				sourceUrl,
				skillPath: lockedSkillPath,
				skillFolderHash,
				pluginName: typeof info.pluginName === "string" ? info.pluginName : undefined,
				lockVersion,
				verified: verificationIssues.length === 0,
				verificationIssues,
			};
		});
	} catch (error) {
		warnings.push(`Failed to read npx skills lock at ${displayPath(path)}: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}

function verifyNpxLockFile(path: string): string[] {
	const issues: string[] = [];
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) issues.push("npx skills lock is a symlink");
		if ((stat.mode & 0o022) !== 0) issues.push("npx skills lock is group/world-writable");
		if (typeof process.getuid === "function" && stat.uid !== process.getuid()) issues.push("npx skills lock is not owned by the current user");
	} catch (error) {
		issues.push(`npx skills lock could not be verified: ${error instanceof Error ? error.message : String(error)}`);
	}
	return issues;
}

function verifyNpxSkill(name: string, path: string, agentsDir: string, lockVersion: number | undefined, info: { source?: string; sourceType?: string; sourceUrl?: string; skillPath?: string; skillFolderHash?: string }, lockIssues: string[]): string[] {
	const issues = [...lockIssues];
	if (lockVersion !== SUPPORTED_NPX_LOCK_VERSION) issues.push(`unsupported npx skills lock version ${lockVersion ?? "unknown"}`);
	if (!SAFE_NPX_SKILL_NAME.test(name)) issues.push("skill name is not safe for CLI use");
	for (const [label, value] of Object.entries(info)) {
		if (!value) issues.push(`missing ${label} in npx skills lock`);
	}
	if (info.sourceType && info.sourceType !== "github") issues.push("npx skill sourceType is not supported for automatic mutation");
	if (info.source && !GITHUB_SOURCE_RE.test(info.source)) issues.push("npx skill source is not a safe GitHub owner/repo");
	if (info.source && info.sourceUrl !== `https://github.com/${info.source}.git`) issues.push("npx skill sourceUrl does not match source");
	if (info.skillFolderHash && !GIT_TREE_SHA_RE.test(info.skillFolderHash)) issues.push("npx skillFolderHash is not a Git tree SHA");
	if (info.skillPath && !isSafeLockedSkillPath(info.skillPath)) issues.push("locked skillPath is unsafe");
	const safety = isSafeNpxSkillPath(path, join(agentsDir, "skills"));
	if (!safety.safe) issues.push(`skill path is not safe: ${safety.reason}`);
	if (!existsSync(join(path, "SKILL.md"))) issues.push("installed skill is missing SKILL.md");
	return issues;
}

function isSafeLockedSkillPath(skillPath: string): boolean {
	if (isAbsolute(skillPath)) return false;
	if (skillPath.split(/[\\/]+/).includes("..")) return false;
	return skillPath.replace(/\\/g, "/").endsWith("/SKILL.md") || skillPath === "SKILL.md";
}

function isSafeNpxSkillPath(skillPath: string, skillsRoot: string): { safe: boolean; reason?: string } {
	try {
		if (!existsSync(skillPath)) return { safe: false, reason: "path does not exist" };
		const stat = lstatSync(skillPath);
		if (stat.isSymbolicLink()) return { safe: false, reason: "refusing to manage symlinked skill directory" };
		const realSkill = realpathSync(skillPath);
		const realRoot = realpathSync(skillsRoot);
		if (realSkill === realRoot || realSkill.startsWith(realRoot + sep)) return { safe: true };
		return { safe: false, reason: "path is outside ~/.agents/skills" };
	} catch (error) {
		return { safe: false, reason: error instanceof Error ? error.message : String(error) };
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
			return [{ name: packageNameFromSource(source), source, scope, filtered: typeof entry === "object", identity: packageIdentityFromSource(source, path), pinned: isPinnedPackageSource(source) }];
		});
	} catch (error) {
		warnings.push(`Failed to read Pi settings at ${displayPath(path)}: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}

function collectLooseSkills(paths: PathsConfig, compound: CompoundManifest | undefined, npxSkills: NpxSkill[]): LooseSkill[] {
	const compoundSkillNames = new Set(compound?.skills ?? []);
	const npxSkillNames = new Set(npxSkills.map((skill) => skill.name));
	const roots: Array<{ path: string; scope: LooseSkill["scope"]; suppressCompound?: boolean; suppressNpx?: boolean }> = [
		{ path: join(paths.agentDir, "skills"), scope: "pi-user", suppressCompound: true },
		{ path: join(paths.agentsDir, "skills"), scope: "agents-user", suppressNpx: true },
		{ path: join(paths.cwd, ".pi", "skills"), scope: "pi-project" },
	];
	const loose: LooseSkill[] = [];
	for (const root of roots) {
		if (!existsSync(root.path)) continue;
		try {
			for (const name of readDirNames(root.path)) {
				if (root.suppressCompound && compoundSkillNames.has(name)) continue;
				if (root.suppressNpx && npxSkillNames.has(name)) continue;
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
	const compoundMember = inventory.compound ? findCompoundMember(target, inventory.compound) : undefined;
	if (inventory.compound && compoundMember) candidates.push(compoundMemberCandidate(inventory.compound, compoundMember));
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
		const member = findCompoundMember(target, inventory.compound);
		if (member) candidates.push(compoundMemberCandidate(inventory.compound, member));
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
		notes: [`This target is owned by \`${manifest.pluginName || COMPOUND_PACKAGE}\`; update delegates to the owning bundle.`],
		update: "supported",
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
		notes: [pkg.pinned ? "Pi package source is pinned; update remains guidance-only." : "Pi package update requires an exact-source/exact-scope updater; current CLI matching is guidance-only.", "Pi package remove is supported after confirmation."],
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
		notes: skill.verified ? [`Safe local npx skill metadata was found; update uses exact \`${SUPPORTED_NPX_SKILLS_CLI_PACKAGE}\`, and removal is Pi-visibility-only by default.`] : ["npx skill provenance is incomplete or unsafe; mutation remains guidance-only.", ...skill.verificationIssues],
		update: skill.verified ? "supported" : "guidance-only",
		remove: skill.verified ? "supported" : "guidance-only",
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
	return Boolean(inventory.compound && findCompoundMember(target, inventory.compound));
}

function findCompoundMember(target: string, manifest: CompoundManifest): string | undefined {
	return manifest.skills.find((name) => normalizeTarget(name) === target) ?? manifest.agents.find((name) => normalizeTarget(name.replace(/\.md$/, "")) === target);
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

function updateGuidance(candidate: Candidate): string[] {
	if (candidate.kind === "pi-package") {
		return [
			"Pi package update remains guidance-only unless an exact-source/exact-scope updater is available.",
			candidate.piPackage?.pinned ? "This package source is pinned, so automatic update is intentionally blocked." : "The broad `pi update --extension <source>` CLI can match more than one configured entry; this extension will not rely on it for single-target mutation.",
		];
	}
	if (candidate.kind === "external-skill") {
		return [
			"This target is an external `npx skills` resource.",
			`Automatic npx updates are supported only for safe global lock entries via exact \`${SUPPORTED_NPX_SKILLS_CLI_PACKAGE}\` execution.`,
			...(candidate.npxSkill?.verificationIssues.map((issue) => `Gate failed: ${issue}`) ?? []),
		];
	}
	return [`This target has no supported update adapter.`, `Supported update targets: \`${COMPOUND_PACKAGE}\`, Compound bundle members, and safe global npx skills.`];
}

function removeGuidance(candidate: Candidate): string[] {
	if (candidate.kind === "external-skill") {
		return [
			"이 target은 external `npx skills` resource입니다.",
			"Mutation is supported only when lock provenance, safe paths, and CLI compatibility gates pass.",
			...(candidate.npxSkill?.verificationIssues.map((issue) => `Gate failed: ${issue}`) ?? []),
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

function packageIdentityFromSource(source: string, settingsPath: string): string {
	if (source.startsWith("npm:")) return `npm:${stripNpmVersion(source.slice("npm:".length))}`;
	const withoutPrefix = source.replace(/^git:/, "");
	const gitMatch = withoutPrefix.match(/(?:https?:\/\/|ssh:\/\/|git:\/\/)?(?:git@)?([^/:]+)[:/]([^/@:]+\/[^/@]+?)(?:\.git)?(?:@[^/]+)?$/);
	if (gitMatch) return `git:${gitMatch[1].toLowerCase()}/${gitMatch[2].replace(/\.git$/, "")}`;
	return `local:${isAbsolute(source) ? resolve(source) : resolve(dirname(settingsPath), source)}`;
}

function isPinnedPackageSource(source: string): boolean {
	if (source.startsWith("npm:")) {
		const spec = source.slice("npm:".length);
		return spec.startsWith("@") ? spec.indexOf("@", 1) !== -1 : spec.includes("@");
	}
	const withoutPrefix = source.replace(/^git:/, "");
	return /(?:\.git|[^/])@[^/]+$/.test(withoutPrefix) && !withoutPrefix.startsWith("git@");
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

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
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
				const raw = readFileSync(path, "utf8");
				const lock = JSON.parse(raw) as { pid?: unknown };
				if (typeof lock.pid === "number" && !isProcessAlive(lock.pid)) {
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
