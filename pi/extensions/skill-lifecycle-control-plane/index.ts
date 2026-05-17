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
	makeReceipt,
	redactDisplay,
	readCompoundSummary,
	readRecentReceipt,
	resolveTarget,
	summarizeExecResult,
	withLifecycleLock,
	type ActionPlan,
	type ApplyResult,
	type Inventory,
} from "./lifecycle";

const RECEIPT_TYPE = "skill-lifecycle-receipt";
const LAST_SHOWN_KEY = "__pi_skill_lifecycle_last_shown_receipt__";

function sendLifecycleMessage(pi: ExtensionAPI, ctx: { ui?: { notify(message: string, type?: "info" | "warning" | "error"): void } }, text: string, type: "info" | "warning" | "error" = "info"): void {
	pi.sendMessage({ customType: "skill-lifecycle", content: text, display: true });
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

async function applyCompoundUpdate(pi: ExtensionAPI, ctx: ExtensionCommandContext, plan: ActionPlan): Promise<ApplyResult> {
	if (!plan.command) return { status: "failed", title: plan.title, changed: false, lines: ["No command was defined for this plan."] };

	return withLifecycleLock(defaultPaths(ctx.cwd), async () => {
		const paths = defaultPaths(ctx.cwd);
		const before = readCompoundSummary(paths);
		const which = await pi.exec("which", [plan.command!.command], { cwd: ctx.cwd, timeout: 5_000, signal: ctx.signal });
		if (which.code !== 0) {
			return {
				status: "failed",
				title: plan.title,
				changed: false,
				lines: [`\`${plan.command!.command}\` executable was not found.`, ...summarizeExecResult(which.code, which.stdout, which.stderr)],
			};
		}

		const executable = which.stdout.trim().split("\n")[0]?.trim() || plan.command!.command;
		const highRiskOk = ctx.hasUI && await ctx.ui.confirm(
			"Run external Compound updater?",
			[
				"This will execute third-party package code after your approval.",
				`Executable: ${executable}`,
				`Command: ${executable} ${plan.command!.args.join(" ")}`,
				"Proceed only if you trust this source.",
			].join("\n"),
		);
		if (!highRiskOk) {
			return { status: "cancelled", title: plan.title, changed: false, lines: ["Cancelled before running external updater."] };
		}

		try {
			const result = await pi.exec(executable, plan.command!.args, { cwd: ctx.cwd, timeout: 180_000, signal: ctx.signal });
			const after = readCompoundSummary(paths);
			const changed = result.code === 0 || before.raw !== after.raw;
			const status: ApplyResult["status"] = result.code === 0 && after.exists ? "success" : "failed";
			return {
				status,
				title: plan.title,
				changed,
				lines: [
					`Before: manifest=${before.exists ? "present" : "missing"}, skills=${before.skills}, agents=${before.agents}`,
					`After: manifest=${after.exists ? "present" : "missing"}, skills=${after.skills}, agents=${after.agents}`,
					...summarizeExecResult(result.code, result.stdout, result.stderr),
				],
			};
		} catch (error) {
			const after = readCompoundSummary(paths);
			return {
				status: "failed",
				title: plan.title,
				changed: before.raw !== after.raw,
				lines: [
					`Before: manifest=${before.exists ? "present" : "missing"}, skills=${before.skills}, agents=${before.agents}`,
					`After: manifest=${after.exists ? "present" : "missing"}, skills=${after.skills}, agents=${after.agents}`,
					`error: ${errorMessage(error)}`,
				],
			};
		}
	});
}

async function applyPiPackageRemove(pi: ExtensionAPI, ctx: ExtensionCommandContext, plan: ActionPlan): Promise<ApplyResult> {
	if (!plan.command) return { status: "failed", title: plan.title, changed: false, lines: ["No command was defined for this plan."] };

	return withLifecycleLock(defaultPaths(ctx.cwd), async () => {
		const result = await pi.exec(plan.command!.command, plan.command!.args, { cwd: ctx.cwd, timeout: 120_000, signal: ctx.signal });
		return {
			status: result.code === 0 ? "success" : "failed",
			title: plan.title,
			changed: result.code === 0,
			lines: summarizeExecResult(result.code, result.stdout, result.stderr),
		};
	});
}

async function finishMutation(pi: ExtensionAPI, ctx: ExtensionCommandContext, result: ApplyResult): Promise<void> {
	const text = [`## ${result.title} ${result.status}`, "", ...result.lines.map((line) => `- ${line}`)].join("\n");
	sendLifecycleMessage(pi, ctx, text, result.status === "success" ? "info" : result.status === "cancelled" ? "warning" : "error");

	if (!result.changed) return;

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

async function handleStatus(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
	const inventory = inventoryFor(pi, ctx);
	const resolution = resolveTarget(args, inventory);
	sendLifecycleMessage(pi, ctx, formatStatus(resolution, inventory), resolution.status === "resolved" ? "info" : "warning");
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
		await finishMutation(pi, ctx, await applyCompoundUpdate(pi, ctx, plan));
	} catch (error) {
		await finishMutation(pi, ctx, failedApplyResult(plan.title, error));
	}
}

async function handleRemove(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
	const inventory = inventoryFor(pi, ctx);
	const resolution = resolveTarget(args, inventory);
	if (resolution.status !== "resolved") {
		sendLifecycleMessage(pi, ctx, formatStatus(resolution, inventory), "warning");
		return;
	}
	const plan = buildRemovePlan(resolution);
	if (!plan.supported) {
		sendLifecycleMessage(pi, ctx, formatPlan(plan), "warning");
		return;
	}
	if (!await confirmPlan(ctx, plan)) {
		sendLifecycleMessage(pi, ctx, `## ${plan.title} cancelled\n\nNo changes were made.`, "warning");
		return;
	}
	try {
		await finishMutation(pi, ctx, await applyPiPackageRemove(pi, ctx, plan));
	} catch (error) {
		await finishMutation(pi, ctx, failedApplyResult(plan.title, error));
	}
}

export default function skillLifecycleControlPlane(pi: ExtensionAPI) {
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
