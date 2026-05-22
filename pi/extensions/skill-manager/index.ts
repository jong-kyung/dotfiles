import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	buildRemovePlan,
	buildUpdatePlan,
	collectInventory,
	defaultPaths,
	filterCompletions,
	formatPlan,
	formatReceipt,
	formatStatus,
	freshnessEvidenceForCandidate,
	freshnessFromFolderHash,
	freshnessFromRemote,
	highestStableSemver,
	makeReceipt,
	redactDisplay,
	readRecentReceipt,
	resolveTarget,
	summarizeExecResult,
	PINNED_NPX_SKILLS_CLI_VERSION,
	unknownFreshness,
	checkUnavailableFreshness,
	withLifecycleLock,
	type ActionPlan,
	type ApplyResult,
	type Candidate,
	type FreshnessResult,
	type Inventory,
	type NpxRemoveMode,
} from "./lifecycle";

const RECEIPT_TYPE = "skill-lifecycle-receipt";
const LAST_SHOWN_KEY = "__pi_skill_lifecycle_last_shown_receipt__";

const STATUS_MESSAGE_TYPE = "skill-lifecycle-status";

async function registerStatusRenderer(pi: ExtensionAPI): Promise<void> {
	try {
		const [{ getMarkdownTheme }, { Box, Markdown, Spacer, Text }] = await Promise.all([
			import("@earendil-works/pi-coding-agent"),
			import("@earendil-works/pi-tui"),
		]);
		pi.registerMessageRenderer(STATUS_MESSAGE_TYPE, (message: { content: unknown; customType?: string }, _options: unknown, theme: { bg(key: string, value: string): string; fg(key: string, value: string): string; bold(value: string): string }) => {
			const text = extractMessageText(message.content) || "(no content)";
			const box = new Box(1, 1, (value: string) => theme.bg("customMessageBg", value));
			box.addChild(new Text(theme.fg("customMessageLabel", theme.bold("[skill-status]")), 0, 0));
			box.addChild(new Spacer(1));
			box.addChild(new Markdown(text, 0, 0, getMarkdownTheme(), { color: (value: string) => theme.fg("customMessageText", value) }));
			return box;
		});
	} catch {
		// Renderer support is best-effort; raw text remains the source of truth.
	}
}

function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part) => isTextPart(part) ? [part.text] : []).join("\n");
}

function isTextPart(value: unknown): value is { type: "text"; text: string } {
	return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "text" && typeof (value as { text?: unknown }).text === "string";
}
function sendLifecycleMessage(pi: ExtensionAPI, ctx: { ui?: { notify(message: string, type?: "info" | "warning" | "error"): void } }, text: string, type: "info" | "warning" | "error" = "info", customType = "skill-lifecycle"): void {
	pi.sendMessage({ customType, content: text, display: true });
	const title = text.split("\n").find((line) => line.trim())?.replace(/^#+\s*/, "").slice(0, 120) ?? "Skill lifecycle";
	ctx.ui?.notify(title, type);
}

function inventoryFor(pi: ExtensionAPI, ctx: ExtensionCommandContext): Inventory {
	return collectInventory(ctx.cwd, pi.getCommands());
}

async function confirmPlan(ctx: ExtensionCommandContext, plan: ActionPlan): Promise<boolean> {
	if (!ctx.hasUI) return false;
	return ctx.ui.confirm(plan.title, formatPlan(plan));
}

async function applyPiPackageUpdate(pi: ExtensionAPI, ctx: ExtensionCommandContext, plan: ActionPlan): Promise<ApplyResult> {
	if (!plan.command) return { status: "failed", title: plan.title, changed: false, lines: ["No command was defined for this plan."] };
	if (isPiOffline()) {
		return { status: "failed", title: plan.title, changed: false, lines: ["PI_OFFLINE is enabled; package update was not run."] };
	}

	const highRiskOk = await confirmHighRiskCommand(ctx, "Run external Pi package update?", plan.command.display, [
		"This can execute package-manager code and may access local credentials or files.",
		"Proceed only if you trust this package source.",
	]);
	if (!highRiskOk) return { status: "cancelled", title: plan.title, changed: false, lines: ["Cancelled before running external Pi package update."] };

	return withLifecycleLock(defaultPaths(ctx.cwd), async () => {
		const paths = defaultPaths(ctx.cwd);
		const stale = revalidatePlan(pi, ctx, plan);
		if (stale) return stale;
		const before = readSettingsSnapshot(paths);
		try {
			const result = await pi.exec(plan.command!.command, plan.command!.args, { cwd: ctx.cwd, timeout: 180_000, signal: ctx.signal });
			const after = readSettingsSnapshot(paths);
			const changed = result.code === 0 || before !== after;
			return {
				status: result.code === 0 ? "success" : "failed",
				title: plan.title,
				changed,
				requiresReload: result.code === 0 || before !== after,
				lines: summarizeExecResult(result.code, result.stdout, result.stderr),
			};
		} catch (error) {
			const after = readSettingsSnapshot(paths);
			const changed = before !== after;
			return {
				status: "failed",
				title: plan.title,
				changed,
				requiresReload: changed,
				lines: [`error: ${errorMessage(error)}`, changed ? "Package state changed before the command failed; reload is required." : "No package state change was detected after the command failed."],
			};
		}
	});
}

async function applyPiPackageRemove(pi: ExtensionAPI, ctx: ExtensionCommandContext, plan: ActionPlan): Promise<ApplyResult> {
	if (!plan.command) return { status: "failed", title: plan.title, changed: false, lines: ["No command was defined for this plan."] };

	return withLifecycleLock(defaultPaths(ctx.cwd), async () => {
		const stale = revalidatePlan(pi, ctx, plan);
		if (stale) return stale;
		const before = readSettingsSnapshot(defaultPaths(ctx.cwd));
		try {
			const result = await pi.exec(plan.command!.command, plan.command!.args, { cwd: ctx.cwd, timeout: 120_000, signal: ctx.signal });
			const after = readSettingsSnapshot(defaultPaths(ctx.cwd));
			const changed = result.code === 0 || before !== after;
			return {
				status: result.code === 0 ? "success" : "failed",
				title: plan.title,
				changed,
				requiresReload: changed,
				lines: [...summarizeExecResult(result.code, result.stdout, result.stderr), ...(result.code !== 0 && before !== after ? ["Settings changed before the command failed; reload is required."] : [])],
			};
		} catch (error) {
			const after = readSettingsSnapshot(defaultPaths(ctx.cwd));
			const changed = before !== after;
			return {
				status: "failed",
				title: plan.title,
				changed,
				requiresReload: changed,
				lines: [`error: ${errorMessage(error)}`, changed ? "Settings changed before the command failed; reload is required." : "No settings change was detected after the command failed."],
			};
		}
	});
}

async function applyNpxSkillMutation(pi: ExtensionAPI, ctx: ExtensionCommandContext, plan: ActionPlan): Promise<ApplyResult> {
	if (plan.npxRemoveMode === "pi-visibility") return applyNpxPiVisibilityRemove(pi, ctx, plan);
	if (!plan.command) return { status: "failed", title: plan.title, changed: false, lines: ["No command was defined for this plan."] };
	if (isPiOffline()) {
		return { status: "failed", title: plan.title, changed: false, lines: ["PI_OFFLINE is enabled; npx skills update was not run."] };
	}

	const highRiskOk = await confirmHighRiskCommand(ctx, "Run external npx skills update?", plan.command.display, [
		"This can execute package-manager code and may access local credentials or files.",
		"Proceed only if you trust this skill source.",
	]);
	if (!highRiskOk) return { status: "cancelled", title: plan.title, changed: false, lines: ["Cancelled before running external npx skills update."] };

	return withLifecycleLock(defaultPaths(ctx.cwd), async () => {
		const stale = revalidatePlan(pi, ctx, plan);
		if (stale) return stale;
		const paths = defaultPaths(ctx.cwd);
		const before = readNpxSnapshot(paths);
		let mutationStarted = false;
		try {
			const packageSpec = plan.command!.args[1];
			const version = await pi.exec(plan.command!.command, ["--yes", packageSpec, "--version"], { cwd: paths.agentDir, timeout: 30_000, signal: ctx.signal });
			const versionLine = version.stdout.trim().split("\n")[0]?.trim() || version.stderr.trim().split("\n")[0]?.trim();
			if (version.code !== 0 || versionLine !== PINNED_NPX_SKILLS_CLI_VERSION) {
				return {
					status: "failed",
					title: plan.title,
					changed: false,
					lines: [`Unsupported or unavailable skills CLI version: ${redactDisplay(versionLine || "unknown")}`, ...summarizeExecResult(version.code, version.stdout, version.stderr)],
				};
			}
			mutationStarted = true;
			const result = await pi.exec(plan.command!.command, plan.command!.args, { cwd: paths.agentDir, timeout: 180_000, signal: ctx.signal });
			const after = readNpxSnapshot(paths);
			const changed = result.code === 0 || before !== after || mutationStarted;
			return {
				status: result.code === 0 ? "success" : "failed",
				title: plan.title,
				changed,
				requiresReload: changed,
				lines: [`skills CLI version: ${redactDisplay(versionLine)}`, ...summarizeExecResult(result.code, result.stdout, result.stderr)],
			};
		} catch (error) {
			const after = readNpxSnapshot(paths);
			const changed = mutationStarted || before !== after;
			return {
				status: "failed",
				title: plan.title,
				changed,
				requiresReload: changed,
				lines: [`error: ${errorMessage(error)}`, changed ? "npx skill update command started before the failure; reload is required." : "No npx skill state change was detected after the command failed."],
			};
		}
	});
}

async function applyNpxPiVisibilityRemove(pi: ExtensionAPI, ctx: ExtensionCommandContext, plan: ActionPlan): Promise<ApplyResult> {
	const skillName = plan.candidate.npxSkill?.name;
	if (!skillName) return { status: "failed", title: plan.title, changed: false, lines: ["No npx skill was defined for this plan."] };

	return withLifecycleLock(defaultPaths(ctx.cwd), async () => {
		const paths = defaultPaths(ctx.cwd);
		const stale = revalidatePlan(pi, ctx, plan);
		if (stale) return stale;
		const result = addUserSkillExclude(paths.userSettingsPath, skillName);
		return {
			status: result.status,
			title: plan.title,
			changed: result.changed,
			requiresReload: result.requiresReload,
			lines: result.lines,
		};
	});
}

async function finishMutation(pi: ExtensionAPI, ctx: ExtensionCommandContext, result: ApplyResult): Promise<void> {
	const text = [`## ${redactDisplay(result.title)} ${result.status}`, "", ...result.lines.map((line) => `- ${redactDisplay(line)}`)].join("\n");
	sendLifecycleMessage(pi, ctx, text, result.status === "success" ? "info" : result.status === "cancelled" ? "warning" : "error");

	if (!result.changed && !result.requiresReload) return;

	const receiptTitle = result.status === "success" ? `${result.title} complete` : `${result.title} changed with ${result.status}`;
	try {
		pi.appendEntry(RECEIPT_TYPE, makeReceipt(receiptTitle, result.lines));
	} catch (error) {
		sendLifecycleMessage(pi, ctx, `## ${result.title} receipt failed\n\n- ${errorMessage(error)}\n- Resources changed; if reload succeeds, this receipt may not be replayed.`, "warning");
	}

	try {
		await ctx.reload();
	} catch (error) {
		sendLifecycleMessage(pi, ctx, `## ${result.title} reload failed\n\n- ${errorMessage(error)}\n- Resources changed; run /reload manually before relying on lifecycle state.`, "error");
	}
}

function failedApplyResult(title: string, error: unknown): ApplyResult {
	return { status: "failed", title, changed: false, lines: [`error: ${errorMessage(error)}`] };
}

function errorMessage(error: unknown): string {
	return redactDisplay(error instanceof Error ? error.message : String(error));
}

function isPiOffline(): boolean {
	const value = process.env.PI_OFFLINE?.toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}

function readSettingsSnapshot(paths: ReturnType<typeof defaultPaths>): string {
	return [paths.userSettingsPath, paths.projectSettingsPath].map((path) => {
		try {
			return existsSync(path) ? readFileSync(path, "utf8") : "";
		} catch (error) {
			return `error:${errorMessage(error)}`;
		}
	}).join("\n---\n");
}

function readNpxSnapshot(paths: ReturnType<typeof defaultPaths>): string {
	const skillPath = join(paths.agentsDir, "skills");
	return [paths.npxSkillLockPath, skillPath].map((path) => {
		try {
			const stat = existsSync(path) ? lstatSync(path) : undefined;
			return stat ? `${path}:${stat.mtimeMs}:${stat.size}` : `${path}:missing`;
		} catch (error) {
			return `${path}:error:${errorMessage(error)}`;
		}
	}).join("\n---\n");
}

async function confirmHighRiskCommand(ctx: ExtensionCommandContext, title: string, command: string, lines: string[]): Promise<boolean> {
	if (!ctx.hasUI) return false;
	return ctx.ui.confirm(title, [...lines, `Command: ${redactDisplay(command)}`, "Proceed only if you trust this source."].join("\n"));
}

function revalidatePlan(pi: ExtensionAPI, ctx: ExtensionCommandContext, plan: ActionPlan): ApplyResult | undefined {
	const target = plan.revalidateTarget ?? plan.candidate.displayName;
	const resolution = resolveTarget(target, inventoryFor(pi, ctx));
	if (resolution.status !== "resolved") {
		return { status: "failed", title: plan.title, changed: false, lines: [`Target changed before execution: ${resolution.status}. No command was run.`] };
	}
	const current = resolution.candidate;
	const expected = plan.candidate;
	if (current.kind !== expected.kind || current.manager !== expected.manager || current.canonicalTarget !== expected.canonicalTarget || current.source !== expected.source || current.scope !== expected.scope) {
		return { status: "failed", title: plan.title, changed: false, lines: ["Target ownership/source changed before execution. No command was run."] };
	}
	if (expected.piPackage) {
		const currentPackage = current.piPackage;
		if (!currentPackage?.updateSupported && plan.kind === "update") {
			return { status: "failed", title: plan.title, changed: false, lines: [currentPackage?.updateBlockedReason ? `Pi package update gate no longer passes: ${currentPackage.updateBlockedReason}` : "Pi package is no longer updateable. No command was run."] };
		}
		if (!currentPackage?.removeSupported && plan.kind === "remove") {
			return { status: "failed", title: plan.title, changed: false, lines: [currentPackage?.removeBlockedReason ? `Pi package remove gate no longer passes: ${currentPackage.removeBlockedReason}` : "Pi package is no longer removable. No command was run."] };
		}
		if (!currentPackage || currentPackage.identity !== expected.piPackage.identity || currentPackage.sourceType !== expected.piPackage.sourceType || currentPackage.filtered !== expected.piPackage.filtered || currentPackage.pinned !== expected.piPackage.pinned) {
			return { status: "failed", title: plan.title, changed: false, lines: ["Pi package identity changed before execution. No command was run."] };
		}
	}
	if (expected.npxSkill) {
		const currentSkill = current.npxSkill;
		if (!currentSkill?.verified) {
			return { status: "failed", title: plan.title, changed: false, lines: ["npx skill provenance is no longer verified. No command was run."] };
		}
		if (currentSkill.source !== expected.npxSkill.source || currentSkill.sourceType !== expected.npxSkill.sourceType || currentSkill.sourceUrl !== expected.npxSkill.sourceUrl || currentSkill.skillPath !== expected.npxSkill.skillPath || currentSkill.skillFolderHash !== expected.npxSkill.skillFolderHash) {
			return { status: "failed", title: plan.title, changed: false, lines: ["npx skill provenance changed before execution. No command was run."] };
		}
	}
	return undefined;
}

export function addUserSkillExclude(settingsPath: string, skillName: string): { status: ApplyResult["status"]; changed: boolean; requiresReload?: boolean; lines: string[] } {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(skillName)) {
		return { status: "failed", changed: false, lines: ["Unsafe skill name; no settings were changed."] };
	}
	try {
		mkdirSync(dirname(settingsPath), { recursive: true });
		const before = existsSync(settingsPath) ? lstatSync(settingsPath) : undefined;
		if (before?.isSymbolicLink()) return { status: "failed", changed: false, lines: ["Refusing to modify symlinked Pi settings file."] };
		const raw = before ? readFileSync(settingsPath, "utf8") : "{}";
		const parsed = raw.trim() ? JSON.parse(raw) as unknown : {};
		if (!isPlainSettingsObject(parsed)) return { status: "failed", changed: false, lines: ["Pi settings file must contain a JSON object; no settings were changed."] };
		const existingSkills = parsed.skills;
		if (existingSkills !== undefined && !Array.isArray(existingSkills)) return { status: "failed", changed: false, lines: ["Pi settings `skills` field must be an array; no settings were changed."] };
		const skills = existingSkills ?? [];
		const exclude = `-skills/${skillName}`;
		if (skills.includes(exclude)) {
			return { status: "success", changed: false, requiresReload: true, lines: [`Pi skill override already contains \`${exclude}\`; reload is still required to refresh current visibility.`] };
		}
		if (!settingsPathStillMatches(settingsPath, before)) return { status: "failed", changed: false, lines: ["Pi settings changed concurrently; no settings were changed."] };
		parsed.skills = [...skills, exclude];
		writeSettingsAtomically(settingsPath, `${JSON.stringify(parsed, null, "\t")}\n`);
		return { status: "success", changed: true, requiresReload: true, lines: [`Added user-scope Pi skill override \`${exclude}\`.`] };
	} catch (error) {
		return { status: "failed", changed: false, lines: [`error: ${errorMessage(error)}`] };
	}
}

function isPlainSettingsObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function settingsPathStillMatches(settingsPath: string, before: ReturnType<typeof lstatSync> | undefined): boolean {
	if (!before) return !existsSync(settingsPath);
	try {
		const current = lstatSync(settingsPath);
		return !current.isSymbolicLink() && current.dev === before.dev && current.ino === before.ino && current.mtimeMs === before.mtimeMs;
	} catch {
		return false;
	}
}

function writeSettingsAtomically(settingsPath: string, content: string): void {
	const tempPath = `${settingsPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	try {
		writeFileSync(tempPath, content, { encoding: "utf8", flag: "wx" });
		renameSync(tempPath, settingsPath);
	} catch (error) {
		try {
			unlinkSync(tempPath);
		} catch {
			// Best-effort cleanup.
		}
		throw error;
	}
}

const GITHUB_API_VERSION = "2022-11-28";
const FRESHNESS_TIMEOUT_MS = 1_500;
const FRESHNESS_CACHE_TTL_MS = 5 * 60 * 1000;
const FRESHNESS_ERROR_TTL_MS = 60 * 1000;
const freshnessCache = new Map<string, { expiresAt: number; value: FreshnessResult }>();
const inflightFreshness = new Map<string, Promise<FreshnessResult>>();

async function determineFreshness(candidate: Candidate, signal?: AbortSignal): Promise<FreshnessResult> {
	const evidence = freshnessEvidenceForCandidate(candidate);
	if (!evidence.repo || (!evidence.localVersion && !evidence.localHash)) return unknownFreshness(evidence.reason);
	if (isPiOffline()) return checkUnavailableFreshness("PI_OFFLINE is enabled");

	const key = freshnessCacheKey(evidence);
	const cached = freshnessCache.get(key);
	if (cached && cached.expiresAt > Date.now()) return cached.value;
	let promise = inflightFreshness.get(key);
	if (!promise) {
		promise = fetchFreshness(evidence)
			.then((value) => {
				freshnessCache.set(key, { expiresAt: Date.now() + (value.status === "check-unavailable" ? FRESHNESS_ERROR_TTL_MS : FRESHNESS_CACHE_TTL_MS), value });
				return value;
			})
			.finally(() => inflightFreshness.delete(key));
		inflightFreshness.set(key, promise);
	}
	return signal ? freshnessForCaller(promise, signal) : promise;
}

export function freshnessCacheKey(evidence: ReturnType<typeof freshnessEvidenceForCandidate>): string {
	return `${evidence.repo}@${evidence.ref ?? "HEAD"}@${evidence.skillPath ?? evidence.localVersion ?? "unknown"}@${evidence.localHash ?? evidence.localVersion ?? "unknown"}`;
}

function freshnessForCaller(promise: Promise<FreshnessResult>, signal: AbortSignal): Promise<FreshnessResult> {
	if (signal.aborted) return Promise.resolve(checkUnavailableFreshness("request cancelled"));
	return new Promise((resolve) => {
		const abort = () => resolve(checkUnavailableFreshness("request cancelled"));
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, () => resolve(checkUnavailableFreshness("GitHub check failed"))).finally(() => signal.removeEventListener("abort", abort));
	});
}

async function fetchFreshness(evidence: ReturnType<typeof freshnessEvidenceForCandidate>): Promise<FreshnessResult> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FRESHNESS_TIMEOUT_MS);
	try {
		if (evidence.repo && evidence.skillPath && evidence.localHash) {
			const latestHash = await fetchLatestSkillFolderHash(evidence.repo, evidence.skillPath, evidence.ref, controller.signal);
			return freshnessFromFolderHash(evidence.localHash, latestHash);
		}
		if (evidence.repo && evidence.localVersion) {
			const remoteVersion = await fetchLatestGitHubStableVersion(evidence.repo, controller.signal);
			return freshnessFromRemote(evidence, remoteVersion);
		}
		return unknownFreshness(evidence.reason);
	} catch (error) {
		return checkUnavailableFreshness(error instanceof Error && error.name === "AbortError" ? "GitHub check timed out" : "GitHub check failed");
	} finally {
		clearTimeout(timeout);
	}
}

interface GitHubTreeEntry {
	path: string;
	type: "blob" | "tree";
	sha: string;
}

interface GitHubRepoTree {
	sha: string;
	tree: GitHubTreeEntry[];
}

async function fetchLatestSkillFolderHash(repo: string, skillPath: string, ref: string | undefined, signal: AbortSignal): Promise<string | undefined> {
	const tree = await fetchRepoTree(repo, ref, signal);
	if (!tree) return undefined;
	return getSkillFolderHashFromTree(tree, skillPath);
}

async function fetchRepoTree(repo: string, ref: string | undefined, signal: AbortSignal): Promise<GitHubRepoTree | undefined> {
	for (const branch of ref ? [ref] : ["HEAD", "main", "master"]) {
		try {
			const tree = await fetchGitHubJson(`https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, signal);
			if (isObject(tree) && typeof tree.sha === "string" && Array.isArray(tree.tree)) {
				return { sha: tree.sha, tree: tree.tree.filter(isGitHubTreeEntry) };
			}
		} catch {
			// Try the next conventional branch/ref.
		}
	}
	return undefined;
}

function getSkillFolderHashFromTree(tree: GitHubRepoTree, skillPath: string): string | undefined {
	let folderPath = skillPath.replace(/\\/g, "/");
	if (folderPath.toLowerCase().endsWith("/skill.md")) folderPath = folderPath.slice(0, -9);
	else if (folderPath.toLowerCase().endsWith("skill.md")) folderPath = folderPath.slice(0, -8);
	if (folderPath.endsWith("/")) folderPath = folderPath.slice(0, -1);
	if (!folderPath) return tree.sha;
	return tree.tree.find((entry) => entry.type === "tree" && entry.path === folderPath)?.sha;
}

function isGitHubTreeEntry(value: unknown): value is GitHubTreeEntry {
	return isObject(value) && typeof value.path === "string" && (value.type === "blob" || value.type === "tree") && typeof value.sha === "string";
}

async function fetchLatestGitHubStableVersion(repo: string, signal: AbortSignal): Promise<string | undefined> {
	const releases = await fetchGitHubJson(`https://api.github.com/repos/${repo}/releases?per_page=30`, signal);
	if (Array.isArray(releases)) {
		const releaseVersions = releases.flatMap((release) => {
			if (!isObject(release) || release.draft === true || release.prerelease === true) return [];
			return [release.tag_name, release.name].filter((value): value is string => typeof value === "string");
		});
		const latestRelease = highestStableSemver(releaseVersions);
		if (latestRelease) return latestRelease;
	}

	const tags = await fetchGitHubJson(`https://api.github.com/repos/${repo}/tags?per_page=100`, signal);
	if (!Array.isArray(tags)) return undefined;
	return highestStableSemver(tags.flatMap((tag) => isObject(tag) && typeof tag.name === "string" ? [tag.name] : []));
}

async function fetchGitHubJson(url: string, signal: AbortSignal): Promise<unknown> {
	const fetcher = globalThis.fetch;
	if (!fetcher) throw new Error("fetch unavailable");
	const response = await fetcher(url, {
		signal,
		headers: {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": GITHUB_API_VERSION,
			"User-Agent": "pi-skill-manager",
		},
	});
	if (!response.ok) throw new Error(`GitHub check failed with ${response.status}`);
	return response.json();
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRemoveArgs(args: string): { target: string; npxRemoveMode: NpxRemoveMode } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const global = tokens.includes("--global");
	return { target: tokens.filter((token) => token !== "--global").join(" "), npxRemoveMode: global ? "global" : "pi-visibility" };
}

async function handleStatus(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
	const inventory = inventoryFor(pi, ctx);
	const resolution = resolveTarget(args, inventory);
	const freshness = resolution.status === "resolved" ? await determineFreshness(resolution.candidate, ctx.signal) : undefined;
	sendLifecycleMessage(pi, ctx, formatStatus(resolution, inventory, freshness), resolution.status === "resolved" ? "info" : "warning", STATUS_MESSAGE_TYPE);
}

async function handleUpdate(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
	const inventory = inventoryFor(pi, ctx);
	const resolution = resolveTarget(args, inventory);
	if (resolution.status !== "resolved") {
		sendLifecycleMessage(pi, ctx, formatStatus(resolution, inventory), "warning");
		return;
	}
	const plan = buildUpdatePlan(resolution);
	if (!plan.supported) {
		sendLifecycleMessage(pi, ctx, formatPlan(plan), "warning");
		return;
	}
	if (!await confirmPlan(ctx, plan)) {
		sendLifecycleMessage(pi, ctx, `## ${plan.title} cancelled\n\nNo changes were made.`, "warning");
		return;
	}
	try {
		const result = plan.candidate.kind === "external-skill"
			? await applyNpxSkillMutation(pi, ctx, plan)
			: plan.candidate.kind === "pi-package"
				? await applyPiPackageUpdate(pi, ctx, plan)
				: { status: "failed", title: plan.title, changed: false, lines: ["No update executor is available for this target."] } satisfies ApplyResult;
		await finishMutation(pi, ctx, result);
	} catch (error) {
		await finishMutation(pi, ctx, failedApplyResult(plan.title, error));
	}
}

async function handleRemove(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
	const parsedArgs = parseRemoveArgs(args);
	const inventory = inventoryFor(pi, ctx);
	const resolution = resolveTarget(parsedArgs.target, inventory);
	if (resolution.status !== "resolved") {
		sendLifecycleMessage(pi, ctx, formatStatus(resolution, inventory), "warning");
		return;
	}
	const plan = buildRemovePlan(resolution, { npxRemoveMode: parsedArgs.npxRemoveMode });
	if (!plan.supported) {
		sendLifecycleMessage(pi, ctx, formatPlan(plan), "warning");
		return;
	}
	if (!await confirmPlan(ctx, plan)) {
		sendLifecycleMessage(pi, ctx, `## ${plan.title} cancelled\n\nNo changes were made.`, "warning");
		return;
	}
	try {
		const result = plan.candidate.kind === "external-skill"
			? await applyNpxSkillMutation(pi, ctx, plan)
			: await applyPiPackageRemove(pi, ctx, plan);
		await finishMutation(pi, ctx, result);
	} catch (error) {
		await finishMutation(pi, ctx, failedApplyResult(plan.title, error));
	}
}

export default function skillLifecycleControlPlane(pi: ExtensionAPI) {
	void registerStatusRenderer(pi);

	pi.on("session_start", (_event, ctx) => {
		const receipt = readRecentReceipt(ctx.sessionManager.getBranch());
		if (!receipt) return;
		const store = globalThis as Record<string, unknown>;
		if (store[LAST_SHOWN_KEY] === receipt.id) return;
		store[LAST_SHOWN_KEY] = receipt.id;
		sendLifecycleMessage(pi, ctx, formatReceipt(receipt), "info");
	});

	pi.registerCommand("skill-status", {
		description: "Inspect Pi skill/package lifecycle target ownership and supported actions",
		getArgumentCompletions: (prefix) => filterCompletions(prefix, collectInventory(process.cwd(), pi.getCommands())),
		handler: async (args, ctx) => handleStatus(pi, ctx, args),
	});

	pi.registerCommand("skill-update", {
		description: "Update a supported Pi skill/package lifecycle target after plan confirmation",
		getArgumentCompletions: (prefix) => filterCompletions(prefix, collectInventory(process.cwd(), pi.getCommands())),
		handler: async (args, ctx) => handleUpdate(pi, ctx, args),
	});

	pi.registerCommand("skill-remove", {
		description: "Remove a supported Pi-managed lifecycle target after plan confirmation",
		getArgumentCompletions: (prefix) => filterCompletions(prefix, collectInventory(process.cwd(), pi.getCommands())),
		handler: async (args, ctx) => handleRemove(pi, ctx, args),
	});
}
