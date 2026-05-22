import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

export type Confidence = "exact" | "inferred" | "ambiguous" | "unsupported";
export type Manager = "plugin-bundle" | "pi-package" | "npx-skills" | "runtime-command" | "loose-skill";
export type TargetKind = "bundle" | "bundle-member" | "pi-package" | "external-skill" | "runtime-command" | "loose-skill";
export type MutationKind = "update" | "remove";
export type ActionSupport = "supported" | "guidance-only" | "unsupported";
export type ApplyStatus = "success" | "failed" | "cancelled";
export type NpxRemoveMode = "pi-visibility" | "global";

export interface PathsConfig {
	cwd: string;
	agentDir: string;
	agentsDir: string;
	npxSkillLockPath: string;
	userSettingsPath: string;
	projectSettingsPath: string;
	lockPath: string;
}

export interface PluginBundleManifest {
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
	ref?: string;
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
	sourceType: "npm" | "git" | "local" | "unknown";
	updateSupported: boolean;
	updateBlockedReason?: string;
	removeSupported: boolean;
	removeBlockedReason?: string;
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
	bundles: PluginBundleManifest[];
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

export type FreshnessStatus = "update-available" | "up-to-date" | "unknown" | "check-unavailable";

export interface FreshnessResult {
	status: FreshnessStatus;
	localVersion?: string;
	remoteVersion?: string;
	reason?: string;
}

export interface FreshnessEvidence {
	repo?: string;
	localVersion?: string;
	ref?: string;
	skillPath?: string;
	localHash?: string;
	reason?: string;
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

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SUPPORTED_NPX_LOCK_VERSION = 3;
export const PINNED_NPX_SKILLS_CLI_VERSION = "1.5.7";
const PINNED_NPX_SKILLS_CLI_PACKAGE = `skills@${PINNED_NPX_SKILLS_CLI_VERSION}`;
const SAFE_NPX_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_PLUGIN_BUNDLE_NAME = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GITHUB_SOURCE_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GIT_TREE_SHA_RE = /^[a-f0-9]{40}$/;
const MALFORMED_LOCK_STALE_MS = 10 * 60 * 1000;

export function defaultPaths(cwd: string): PathsConfig {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	const agentsDir = join(homedir(), ".agents");
	return {
		cwd,
		agentDir,
		agentsDir,
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
	const bundles = readPluginBundleManifests(paths, warnings);
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
	const looseSkills = collectLooseSkills(paths, bundles, npxSkills);

	return { paths, bundles, npxSkills, piPackages, runtimeCommands, looseSkills, warnings };
}

export function resolveTarget(input: string, inventory: Inventory): Resolution {
	const target = normalizeTarget(input);
	if (!target) {
		return { status: "unsupported", target, suggestions: topLevelCandidates(inventory), reason: "No target provided." };
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

	if (candidate.kind === "external-skill" && candidate.npxSkill?.verified) {
		const args = ["--yes", PINNED_NPX_SKILLS_CLI_PACKAGE, "update", candidate.npxSkill.name, "-g", "-y"];
		return {
			kind: "update",
			title: `Update ${candidate.displayName}`,
			candidate,
			supported: true,
			guidanceOnly: false,
			steps: [
				"Safe global npx skills lock metadata and installed path are required before this plan is built.",
				`Before mutation, run the exact \`${PINNED_NPX_SKILLS_CLI_PACKAGE}\` CLI version check.`,
				"Run a single-skill npx skills update with non-interactive arguments.",
				"Reload Pi after a successful update because resource content can change without settings/count changes.",
			],
			warnings: ["This runs external package-manager code. Proceed only if you trust this skill source and local credentials exposure risk."],
			command: { command: "npx", args, display: `npx ${args.join(" ")}` },
			requiresReload: true,
			revalidateTarget: candidate.displayName,
		};
	}

	if (candidate.kind === "pi-package" && candidate.piPackage?.updateSupported) {
		const args = ["update", candidate.piPackage.source];
		return {
			kind: "update",
			title: `Update ${candidate.displayName}`,
			candidate,
			supported: true,
			guidanceOnly: false,
			steps: [
				"Pi package settings에서 exact-one unpinned npm/git package entry를 확인합니다.",
				"실행 직전 같은 source/scope/identity가 여전히 exact-one인지 재검증합니다.",
				"확인 후 단일 source Pi package update를 실행합니다.",
				"Package content가 바뀌었을 수 있으므로 reload receipt를 남기고 runtime을 refresh합니다.",
			],
			warnings: ["이 명령은 외부 package code를 실행합니다. 실행 직전 high-risk confirmation을 한 번 더 요구합니다.", ...(candidate.piPackage.filtered ? ["This package entry has filters; existing filters remain in effect after update."] : [])],
			command: { command: "pi", args, display: `pi ${args.join(" ")}` },
			requiresReload: true,
			revalidateTarget: candidate.source ?? candidate.displayName,
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

	if (candidate.kind === "pi-package" && candidate.piPackage?.removeSupported) {
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

export function unknownFreshness(reason = "no comparable local version"): FreshnessResult {
	return { status: "unknown", reason };
}

export function checkUnavailableFreshness(reason = "remote update check unavailable"): FreshnessResult {
	return { status: "check-unavailable", reason };
}

export function compareStableSemver(a: string, b: string): number | undefined {
	const left = parseStableSemver(a);
	const right = parseStableSemver(b);
	if (!left || !right) return undefined;
	for (const key of ["major", "minor", "patch"] as const) {
		if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
	}
	return 0;
}

export function highestStableSemver(values: string[]): string | undefined {
	let best: string | undefined;
	for (const value of values) {
		const parsed = parseStableSemver(value);
		if (!parsed) continue;
		const normalized = semverToString(parsed);
		if (!best || compareStableSemver(normalized, best)! > 0) best = normalized;
	}
	return best;
}

export function freshnessEvidenceForCandidate(candidate: Candidate): FreshnessEvidence {
	if (candidate.npxSkill?.source && GITHUB_SOURCE_RE.test(candidate.npxSkill.source)) {
		return candidate.npxSkill.skillPath && candidate.npxSkill.skillFolderHash
			? { repo: candidate.npxSkill.source, ref: candidate.npxSkill.ref, skillPath: candidate.npxSkill.skillPath, localHash: candidate.npxSkill.skillFolderHash }
			: { repo: candidate.npxSkill.source, reason: "no skill folder hash" };
	}
	if (candidate.piPackage?.sourceType === "git") {
		const parsed = parseGitHubPackageSource(candidate.piPackage.source);
		if (!parsed?.repo) return { reason: "no supported GitHub source" };
		const localVersion = parsed.ref ? normalizeStableSemver(parsed.ref) : undefined;
		return localVersion
			? { repo: parsed.repo, localVersion }
			: { repo: parsed.repo, reason: "no comparable local version" };
	}
	return { reason: "no supported GitHub source" };
}


export function freshnessFromFolderHash(localHash: string, latestHash: string | undefined): FreshnessResult {
	if (!latestHash) return checkUnavailableFreshness("latest skill folder hash could not be determined");
	return localHash === latestHash
		? { status: "up-to-date" }
		: { status: "update-available", reason: "skill folder changed upstream" };
}

export function freshnessFromRemote(evidence: FreshnessEvidence, remoteVersion: string | undefined): FreshnessResult {
	if (!evidence.repo || !evidence.localVersion) return unknownFreshness(evidence.reason);
	if (!remoteVersion) return checkUnavailableFreshness("latest release/tag could not be determined");
	const comparison = compareStableSemver(remoteVersion, evidence.localVersion);
	if (comparison === undefined) return checkUnavailableFreshness("latest release/tag could not be determined");
	return {
		status: comparison > 0 ? "update-available" : "up-to-date",
		localVersion: evidence.localVersion,
		remoteVersion: normalizeStableSemver(remoteVersion),
	};
}

function parseGitHubPackageSource(source: string): { repo?: string; ref?: string } | undefined {
	let value = source.replace(/^git:/, "");
	let ref: string | undefined;
	const hashIndex = value.indexOf("#");
	if (hashIndex !== -1) {
		ref = value.slice(hashIndex + 1);
		value = value.slice(0, hashIndex);
	}
	const httpsMatch = value.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
	if (httpsMatch) return { repo: `${httpsMatch[1]}/${httpsMatch[2]}`, ref };
	const sshMatch = value.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
	if (sshMatch) return { repo: `${sshMatch[1]}/${sshMatch[2]}`, ref };
	return undefined;
}

function normalizeStableSemver(value: string | undefined): string | undefined {
	const parsed = parseStableSemver(value);
	return parsed ? semverToString(parsed) : undefined;
}

function parseStableSemver(value: string | undefined): { major: number; minor: number; patch: number } | undefined {
	const match = value?.trim().match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/);
	if (!match) return undefined;
	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function semverToString(version: { major: number; minor: number; patch: number }): string {
	return `${version.major}.${version.minor}.${version.patch}`;
}

export function formatStatus(resolution: Resolution, inventory: Inventory, freshness: FreshnessResult = unknownFreshness()): string {
	if (resolution.status === "ambiguous") {
		const lines = [
			`## Skill lifecycle status: ambiguous target \`${resolution.target}\``,
			"",
			"Multiple candidates matched. No mutation will run until the target is disambiguated.",
			"",
			...resolution.candidates.flatMap((candidate) => formatCandidateSummary(candidate).map((line) => `- ${line}`)),
		];
		if (inventory.warnings.length > 0) lines.push("", "Warnings:", ...inventory.warnings.map((warning) => `- ${warning}`));
		return lines.join("\n");
	}

	if (resolution.status === "unsupported") {
		const noTarget = !resolution.target;
		const lines = [
			`## Skill lifecycle status: ${noTarget ? "target required" : "unsupported target"}`,
			"",
			resolution.reason,
		];
		if (noTarget) {
			lines.push(
				"",
				"Usage: `/skill-status <target>`",
				"Start typing a skill, package, or plugin name to use completions. Bundle member names still work as explicit targets, but the overview below lists only top-level owners to avoid inferred noise.",
			);
		}
		if (resolution.suggestions.length > 0) {
			lines.push("", noTarget ? "Top-level targets:" : "Possible targets:");
			for (const suggestion of resolution.suggestions.slice(0, noTarget ? 12 : 8)) {
				const detail = noTarget ? suggestion.manager : `${suggestion.manager} (${suggestion.confidence})`;
				lines.push(`- \`${suggestion.canonicalTarget}\` — ${detail}`);
			}
		} else {
			lines.push("", "Known top-level targets:", ...completionItems(inventory).slice(0, 12).map((item) => `- \`${item.value}\` — ${item.description ?? item.label}`));
		}
		if (inventory.warnings.length > 0) lines.push("", "Warnings:", ...inventory.warnings.map((warning) => `- ${warning}`));
		return lines.join("\n");
	}

	const candidate = resolution.candidate;
	const lines = [`## Skill lifecycle status: \`${candidate.displayName}\``, "", ...formatCandidate(candidate, freshness)];
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

function readPluginBundleManifests(paths: PathsConfig, warnings: string[]): PluginBundleManifest[] {
	if (!existsSync(paths.agentDir)) return [];
	const manifests: PluginBundleManifest[] = [];
	try {
		for (const entry of readdirSync(paths.agentDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const root = join(paths.agentDir, entry.name);
			const manifest = readPluginBundleManifest(join(root, "install-manifest.json"), warnings);
			if (manifest) manifests.push(manifest);
			if (entry.name.startsWith("@")) {
				try {
					for (const scopedEntry of readdirSync(root, { withFileTypes: true })) {
						if (!scopedEntry.isDirectory()) continue;
						const scopedManifest = readPluginBundleManifest(join(root, scopedEntry.name, "install-manifest.json"), warnings);
						if (scopedManifest) manifests.push(scopedManifest);
					}
				} catch {
					// Scoped package directories are best-effort discovery.
				}
			}
		}
	} catch (error) {
		warnings.push(`Failed to scan plugin bundle manifests at ${displayPath(paths.agentDir)}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return manifests;
}

function readPluginBundleManifest(path: string, warnings: string[]): PluginBundleManifest | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink()) {
			warnings.push(`Ignored unsafe plugin bundle manifest at ${displayPath(path)}.`);
			return undefined;
		}
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as { pluginName?: unknown; skills?: unknown; agents?: unknown };
		if (typeof parsed.pluginName !== "string" || !SAFE_PLUGIN_BUNDLE_NAME.test(parsed.pluginName)) {
			warnings.push(`Ignored plugin bundle manifest at ${displayPath(path)} because pluginName is missing or unsafe.`);
			return undefined;
		}
		return {
			pluginName: parsed.pluginName,
			skills: Array.isArray(parsed.skills) ? parsed.skills.filter((item): item is string => typeof item === "string") : [],
			agents: Array.isArray(parsed.agents) ? parsed.agents.filter((item): item is string => typeof item === "string") : [],
			path,
			raw,
		};
	} catch (error) {
		warnings.push(`Failed to read plugin bundle manifest at ${displayPath(path)}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

function readNpxSkillLock(path: string, agentsDir: string, warnings: string[]): NpxSkill[] {
	if (!existsSync(path)) return [];
	try {
		const lockIssues = verifyNpxLockFile(path);
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; skills?: unknown };
		const lockVersion = typeof parsed.version === "number" ? parsed.version : undefined;
		const skills = isJsonObject(parsed.skills) ? parsed.skills : {};
		if (parsed.skills !== undefined && !isJsonObject(parsed.skills)) warnings.push(`Ignored malformed npx skills lock entries at ${displayPath(path)} because skills is not an object.`);
		return Object.entries(skills).flatMap(([name, rawInfo]) => {
			if (!isJsonObject(rawInfo)) {
				warnings.push(`Ignored malformed npx skills lock entry for ${name} at ${displayPath(path)}.`);
				return [];
			}
			const info = rawInfo;
			const skillPath = join(agentsDir, "skills", name);
			const source = typeof info.source === "string" ? info.source : undefined;
			const sourceType = typeof info.sourceType === "string" ? info.sourceType : undefined;
			const sourceUrl = typeof info.sourceUrl === "string" ? info.sourceUrl : undefined;
			const lockedSkillPath = typeof info.skillPath === "string" ? info.skillPath : undefined;
			const skillFolderHash = typeof info.skillFolderHash === "string" ? info.skillFolderHash : undefined;
			const ref = typeof info.ref === "string" ? info.ref : undefined;
			const verificationIssues = verifyNpxSkill(name, skillPath, agentsDir, lockVersion, { source, sourceType, sourceUrl, skillPath: lockedSkillPath, skillFolderHash }, lockIssues);
			return [{
				name,
				path: skillPath,
				source,
				sourceType,
				sourceUrl,
				skillPath: lockedSkillPath,
				skillFolderHash,
				ref,
				pluginName: typeof info.pluginName === "string" ? info.pluginName : undefined,
				lockVersion,
				verified: verificationIssues.length === 0,
				verificationIssues,
			}];
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
	const user = readPackagesFromSettings(paths.userSettingsPath, "user", warnings);
	const project = readPackagesFromSettings(paths.projectSettingsPath, "project", warnings);
	const packages = [...user.packages, ...project.packages];
	const settingsReadFailed = user.failed || project.failed;
	const identityCounts = new Map<string, number>();
	for (const pkg of packages) identityCounts.set(pkg.identity, (identityCounts.get(pkg.identity) ?? 0) + 1);
	return packages.map((pkg) => {
		const identityCount = identityCounts.get(pkg.identity) ?? 0;
		const updateBlockedReason = packageUpdateBlockedReason(pkg, identityCount, settingsReadFailed);
		const removeBlockedReason = packageRemoveBlockedReason(pkg, identityCount, settingsReadFailed);
		return { ...pkg, updateSupported: !updateBlockedReason, updateBlockedReason, removeSupported: !removeBlockedReason, removeBlockedReason };
	});
}

function readPackagesFromSettings(path: string, scope: "user" | "project", warnings: string[]): { packages: Array<Omit<PiPackage, "updateSupported" | "updateBlockedReason" | "removeSupported" | "removeBlockedReason">>; failed: boolean } {
	if (!existsSync(path)) return { packages: [], failed: false };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { packages?: unknown[] };
		return {
			failed: false,
			packages: (parsed.packages ?? []).flatMap((entry) => {
				const source = typeof entry === "string" ? entry : entry && typeof entry === "object" && typeof (entry as { source?: unknown }).source === "string" ? (entry as { source: string }).source : undefined;
				if (!source) return [];
				const sourceType = packageSourceType(source);
				return [{ name: packageNameFromSource(source), source, scope, filtered: typeof entry === "object", identity: packageIdentityFromSource(source, path), pinned: isPinnedPackageSource(source), sourceType }];
			}),
		};
	} catch (error) {
		warnings.push(`Failed to read Pi settings at ${displayPath(path)}: ${error instanceof Error ? error.message : String(error)}`);
		return { packages: [], failed: true };
	}
}

function packageUpdateBlockedReason(pkg: Omit<PiPackage, "updateSupported" | "updateBlockedReason" | "removeSupported" | "removeBlockedReason">, identityCount: number, settingsReadFailed: boolean): string | undefined {
	if (settingsReadFailed) return "Pi settings could not be fully read; update would be unsafe.";
	if (identityCount !== 1) return "Package identity is configured more than once; update would not be exact-scope.";
	if (pkg.pinned) return "Package source is pinned; automatic update is intentionally blocked.";
	if (pkg.sourceType === "local") return "Local path packages are not updateable by Pi package manager.";
	if (pkg.sourceType !== "npm" && pkg.sourceType !== "git") return "Package source type is not supported for automatic update.";
	if (!isSafePackageUpdateSource(pkg.source, pkg.sourceType)) return "Package source is not a safe unpinned npm/git spec.";
	return undefined;
}

function packageRemoveBlockedReason(pkg: Omit<PiPackage, "updateSupported" | "updateBlockedReason" | "removeSupported" | "removeBlockedReason">, identityCount: number, settingsReadFailed: boolean): string | undefined {
	if (settingsReadFailed) return "Pi settings could not be fully read; remove would be unsafe.";
	if (identityCount !== 1) return "Package identity is configured more than once; remove would not be exact-scope.";
	return undefined;
}

function collectLooseSkills(paths: PathsConfig, bundles: PluginBundleManifest[], npxSkills: NpxSkill[]): LooseSkill[] {
	const bundleSkillNames = new Set(bundles.flatMap((bundle) => bundle.skills));
	const npxSkillNames = new Set(npxSkills.map((skill) => skill.name));
	const roots: Array<{ path: string; scope: LooseSkill["scope"]; suppressBundle?: boolean; suppressNpx?: boolean }> = [
		{ path: join(paths.agentDir, "skills"), scope: "pi-user", suppressBundle: true },
		{ path: join(paths.agentsDir, "skills"), scope: "agents-user", suppressNpx: true },
		{ path: join(paths.cwd, ".pi", "skills"), scope: "pi-project" },
	];
	const loose: LooseSkill[] = [];
	for (const root of roots) {
		if (!existsSync(root.path)) continue;
		try {
			for (const name of readDirNames(root.path)) {
				if (root.suppressBundle && bundleSkillNames.has(name)) continue;
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
	for (const bundle of inventory.bundles) {
		if (normalizeTarget(bundle.pluginName) === target) candidates.push(pluginBundleCandidate(bundle));
		const bundleMember = findPluginBundleMember(target, bundle);
		if (bundleMember) candidates.push(pluginBundleMemberCandidate(bundle, bundleMember));
	}
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
		if (commandTarget === target && !isPluginBundleMemberTarget(target, inventory) && !candidateAlreadyExplainsCommand(command, candidates)) candidates.push(runtimeCommandCandidate(command));
	}
	return candidates;
}

function inferredCandidates(target: string, inventory: Inventory): Candidate[] {
	const candidates: Candidate[] = [];
	for (const bundle of inventory.bundles) {
		const member = findPluginBundleMember(target, bundle);
		if (member) candidates.push(pluginBundleMemberCandidate(bundle, member));
	}
	for (const command of inventory.runtimeCommands) {
		const commandName = normalizeTarget(command.name.replace(/^skill:/, ""));
		if (commandName === target && !isPluginBundleMemberTarget(target, inventory) && !candidateAlreadyExplainsCommand(command, candidates)) candidates.push(runtimeCommandCandidate(command, "inferred"));
	}
	return candidates;
}

function discoverableCandidates(inventory: Inventory): Candidate[] {
	const candidates: Candidate[] = [];
	for (const bundle of inventory.bundles) {
		candidates.push(pluginBundleCandidate(bundle));
		for (const skill of bundle.skills) candidates.push(pluginBundleMemberCandidate(bundle, skill));
		for (const agent of bundle.agents) candidates.push(pluginBundleMemberCandidate(bundle, agent));
	}
	candidates.push(...topLevelCandidates(inventory).filter((candidate) => candidate.kind !== "bundle"));
	return candidates;
}

function topLevelCandidates(inventory: Inventory): Candidate[] {
	const candidates: Candidate[] = [];
	for (const bundle of inventory.bundles) candidates.push(pluginBundleCandidate(bundle));
	for (const pkg of inventory.piPackages) candidates.push(piPackageCandidate(pkg));
	for (const skill of inventory.npxSkills) candidates.push(npxSkillCandidate(skill));
	for (const loose of inventory.looseSkills) candidates.push(looseSkillCandidate(loose));
	return candidates;
}

function pluginBundleCandidate(manifest: PluginBundleManifest): Candidate {
	return {
		kind: "bundle",
		manager: "plugin-bundle",
		confidence: "exact",
		canonicalTarget: manifest.pluginName,
		displayName: manifest.pluginName,
		source: manifest.path,
		resources: [
			{ label: "skills", count: manifest.skills.length, manager: "plugin-bundle" },
			{ label: "agents", count: manifest.agents.length, manager: "plugin-bundle" },
			{ label: "manifest", path: manifest.path, manager: "plugin-bundle" },
		],
		notes: ["Plugin bundle status is discovered from its local manifest; update is manual/guidance-only until updater metadata exists.", "Plugin bundle removal is guidance-only until safe purge/restore semantics exist."],
		update: "guidance-only",
		remove: "guidance-only",
	};
}

function pluginBundleMemberCandidate(manifest: PluginBundleManifest, member: string): Candidate {
	return {
		kind: "bundle-member",
		manager: "plugin-bundle",
		confidence: "inferred",
		canonicalTarget: manifest.pluginName,
		displayName: member.replace(/\.md$/, ""),
		source: manifest.path,
		resources: [{ label: "owning bundle", path: manifest.path, manager: "plugin-bundle" }],
		notes: [`This target is owned by \`${manifest.pluginName}\`; update is manual/guidance-only until the owning bundle declares updater metadata.`],
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
		notes: [
			pkg.updateSupported ? "Unpinned npm/git Pi package has exact-one identity; update is supported after confirmation." : pkg.updateBlockedReason ?? "Pi package update is guidance-only.",
			pkg.removeSupported ? "Pi package remove is supported after confirmation." : pkg.removeBlockedReason ?? "Pi package remove is guidance-only.",
		],
		update: pkg.updateSupported ? "supported" : "guidance-only",
		remove: pkg.removeSupported ? "supported" : "guidance-only",
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
		notes: skill.verified ? [`Safe local npx skill metadata was found; update uses exact \`${PINNED_NPX_SKILLS_CLI_PACKAGE}\`, and removal is Pi-visibility-only by default.`] : ["npx skill provenance is incomplete or unsafe; mutation remains guidance-only.", ...skill.verificationIssues],
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
		notes: ["Loose skill provenance learning is deferred; mutation is unsupported."],
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

function isPluginBundleMemberTarget(target: string, inventory: Inventory): boolean {
	return inventory.bundles.some((bundle) => Boolean(findPluginBundleMember(target, bundle)));
}

function findPluginBundleMember(target: string, manifest: PluginBundleManifest): string | undefined {
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
			"Pi package update is supported only for exact-one unpinned npm/git package entries.",
			candidate.piPackage?.updateBlockedReason ? `Gate failed: ${candidate.piPackage.updateBlockedReason}` : "This package did not pass automatic update gates.",
		];
	}
	if (candidate.kind === "bundle" || candidate.kind === "bundle-member") {
		return [
			"This target is owned by a discovered plugin bundle manifest.",
			"Automatic update is guidance-only until the bundle declares updater/source metadata; run the bundle's installer/update command manually.",
		];
	}
	if (candidate.kind === "external-skill") {
		return [
			"This target is an external `npx skills` resource.",
			`Automatic npx updates are supported only for safe global lock entries via exact \`${PINNED_NPX_SKILLS_CLI_PACKAGE}\` execution.`,
			...(candidate.npxSkill?.verificationIssues.map((issue) => `Gate failed: ${issue}`) ?? []),
		];
	}
	return ["This target has no supported update adapter.", "Supported update targets: exact-one unpinned npm/git Pi packages and safe global npx skills."];
}

function removeGuidance(candidate: Candidate): string[] {
	if (candidate.kind === "pi-package") {
		return [
			"Pi package remove is supported only when the settings target resolves to exactly one package identity.",
			candidate.piPackage?.removeBlockedReason ? `Gate failed: ${candidate.piPackage.removeBlockedReason}` : "This package did not pass automatic remove gates.",
		];
	}
	if (candidate.kind === "external-skill") {
		return [
			"이 target은 external `npx skills` resource입니다.",
			"Mutation is supported only when lock provenance, safe paths, and CLI compatibility gates pass.",
			...(candidate.npxSkill?.verificationIssues.map((issue) => `Gate failed: ${issue}`) ?? []),
		];
	}
	if (candidate.kind === "bundle" || candidate.kind === "bundle-member") {
		return ["Plugin bundle/member removal은 v1에서 guidance-only입니다.", "Plugin bundle full removal은 별도 purge/restore 설계가 필요합니다."];
	}
	return ["This target has no supported remove adapter."];
}

function formatCandidateSummary(candidate: Candidate): string[] {
	return [
		`Identity: \`${redactDisplay(candidate.displayName)}\``,
		`Canonical target: \`${redactDisplay(candidate.canonicalTarget)}\``,
		`Manager: ${candidate.manager}`,
		`Update action: ${formatActionAvailability(candidate.update)}`,
		`Remove action: ${formatActionAvailability(candidate.remove)}`,
	];
}

function formatCandidate(candidate: Candidate, freshness: FreshnessResult): string[] {
	const reason = formatPrimaryReason(candidate, freshness);
	const lines = [
		`Identity: \`${redactDisplay(candidate.displayName)}\``,
		`Canonical target: \`${redactDisplay(candidate.canonicalTarget)}\``,
		`Manager: ${candidate.manager}`,
		`Remote update: ${formatFreshness(freshness)}`,
	];
	if (reason) lines.push(`Reason: ${redactDisplay(reason)}`);
	lines.push(
		"",
		"Actions:",
		"| Action | Availability |",
		"| --- | --- |",
		`| Status | ${formatActionAvailability("supported")} |`,
		`| Update | ${formatActionAvailability(candidate.update)} |`,
		`| Remove | ${formatActionAvailability(candidate.remove)} |`,
		"",
	);
	if (candidate.source) lines.push(`Source: ${displaySafePath(candidate.source)}`);
	if (candidate.scope) lines.push(`Scope: ${candidate.scope}`);
	if (candidate.resources.length > 0) {
		lines.push("Resources:");
		for (const resource of candidate.resources) {
			const detail = resource.count !== undefined ? `${resource.count}` : resource.path ? displaySafePath(resource.path) : "";
			lines.push(`  - ${redactDisplay(resource.label)}${detail ? `: ${detail}` : ""}`);
		}
	}
	return lines;
}

function formatFreshness(freshness: FreshnessResult): string {
	const versionDetail = freshness.localVersion && freshness.remoteVersion ? ` (${redactDisplay(freshness.localVersion)} → ${redactDisplay(freshness.remoteVersion)})` : "";
	if (freshness.status === "update-available") return `**Update Available**${versionDetail}`;
	if (freshness.status === "up-to-date") return `**Up to date**${versionDetail}`;
	if (freshness.status === "check-unavailable") return "**Check unavailable**";
	return "**Unknown**";
}

function formatPrimaryReason(candidate: Candidate, freshness: FreshnessResult): string | undefined {
	if (candidate.update !== "supported") return candidate.piPackage?.updateBlockedReason ?? candidate.npxSkill?.verificationIssues[0] ?? candidate.notes[0];
	if (candidate.remove !== "supported") return candidate.piPackage?.removeBlockedReason ?? candidate.npxSkill?.verificationIssues[0] ?? candidate.notes[0];
	return freshness.reason;
}

function formatActionAvailability(support: ActionSupport): string {
	if (support === "supported") return "Supported";
	if (support === "guidance-only") return "Guidance only";
	return "Unsupported";
}

function packageIdentityFromSource(source: string, settingsPath: string): string {
	if (source.startsWith("npm:")) return `npm:${stripNpmVersion(source.slice("npm:".length))}`;
	const withoutPrefix = stripGitRef(source.replace(/^git:/, ""));
	const gitMatch = withoutPrefix.match(/(?:https?:\/\/|ssh:\/\/|git:\/\/)?(?:git@)?([^/:@]+)[:/]([^@]+?)(?:\.git)?$/);
	if (gitMatch && gitMatch[2].includes("/")) return `git:${gitMatch[1].toLowerCase()}/${gitMatch[2].replace(/\.git$/, "")}`;
	return `local:${isAbsolute(source) ? resolve(source) : resolve(dirname(settingsPath), source)}`;
}

function packageSourceType(source: string): PiPackage["sourceType"] {
	if (source.startsWith("npm:")) return "npm";
	if (source.startsWith("git:") || /^(?:https?|ssh|git):\/\//.test(source) || source.startsWith("git@")) return "git";
	if (isAbsolute(source) || source.startsWith("./") || source.startsWith("../")) return "local";
	return "unknown";
}

function isSafePackageUpdateSource(source: string, sourceType: PiPackage["sourceType"]): boolean {
	if (/\s|[\u0000-\u001f\u007f]/.test(source)) return false;
	if (source.startsWith("-")) return false;
	if (sourceType === "npm") {
		const spec = source.slice("npm:".length);
		return /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/i.test(spec);
	}
	if (sourceType === "git") {
		const withoutPrefix = source.replace(/^git:/, "");
		if (withoutPrefix.startsWith("-") || withoutPrefix.startsWith(".") || withoutPrefix.startsWith("/")) return false;
		return /^(?:https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?|git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?)$/.test(withoutPrefix);
	}
	return false;
}

function isPinnedPackageSource(source: string): boolean {
	if (source.startsWith("npm:")) {
		const spec = source.slice("npm:".length);
		return spec.startsWith("@") ? spec.indexOf("@", 1) !== -1 : spec.includes("@");
	}
	if (packageSourceType(source) !== "git") return false;
	const withoutPrefix = source.replace(/^git:/, "");
	if (withoutPrefix.includes("#")) return true;
	if (withoutPrefix.startsWith("git@")) {
		const repoPart = withoutPrefix.slice(withoutPrefix.indexOf(":") + 1);
		return repoPart.includes("@");
	}
	const protocolMatch = withoutPrefix.match(/^[a-z]+:\/\/(.+)$/i);
	if (protocolMatch) {
		const firstPathSlash = protocolMatch[1].indexOf("/");
		return firstPathSlash !== -1 && protocolMatch[1].slice(firstPathSlash + 1).includes("@");
	}
	return withoutPrefix.includes("@");
}

function stripGitRef(source: string): string {
	const withoutHash = source.split("#")[0];
	if (withoutHash.startsWith("git@")) {
		const colon = withoutHash.indexOf(":");
		if (colon === -1) return withoutHash;
		const prefix = withoutHash.slice(0, colon + 1);
		const repo = withoutHash.slice(colon + 1);
		return `${prefix}${repo.split("@")[0]}`;
	}
	const protocolMatch = withoutHash.match(/^([a-z]+:\/\/)(.+)$/i);
	if (protocolMatch) {
		const firstPathSlash = protocolMatch[2].indexOf("/");
		if (firstPathSlash === -1) return withoutHash;
		const authority = protocolMatch[2].slice(0, firstPathSlash + 1);
		const path = protocolMatch[2].slice(firstPathSlash + 1).split("@")[0];
		return `${protocolMatch[1]}${authority}${path}`;
	}
	return withoutHash.split("@")[0];
}

function packageNameFromSource(source: string): string {
	const withoutPrefix = source.replace(/^npm:/, "").replace(/^git:/, "");
	if (source.startsWith("npm:")) return stripNpmVersion(withoutPrefix);
	const withoutRef = withoutPrefix.split("#")[0];
	const urlMatch = withoutRef.match(/([^/@:]+\/[^/@]+?)(?:\.git)?(?:@[^/]+)?$/);
	if (urlMatch) return urlMatch[1].split("/").pop() ?? withoutRef;
	return withoutRef.replace(/@[^@/]+$/, "");
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
				try {
					const stat = lstatSync(path);
					if (!stat.isSymbolicLink() && Date.now() - stat.mtimeMs > MALFORMED_LOCK_STALE_MS) {
						unlinkSync(path);
						return acquireLock(path);
					}
				} catch {
					// Fall through to useful error.
				}
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
