/**
 * Loop Extension
 *
 * Provides a /loop command that starts a follow-up loop with a breakout condition.
 * The loop keeps sending a prompt on turn end until the agent calls the
 * signal_loop_success tool.
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compact } from "@earendil-works/pi-coding-agent";

type LoopMode = "tests" | "custom" | "self";

type LoopStateData = {
	active: boolean;
	mode?: LoopMode;
	condition?: string;
	prompt?: string;
	summary?: string;
	loopCount?: number;
};

const LOOP_PRESETS = [
	{ value: "tests", label: "Until tests pass" },
	{ value: "custom", label: "Until custom condition" },
	{ value: "self", label: "Self driven (agent decides)" },
] as const;

const LOOP_STATE_ENTRY = "loop-state";

function buildPrompt(mode: LoopMode, condition?: string): string {
	switch (mode) {
		case "tests":
			return (
				"Run all tests. If they are passing, call the signal_loop_success tool. " +
				"Otherwise continue until the tests pass."
			);
		case "custom": {
			const customCondition = condition?.trim() || "the custom condition is satisfied";
			return (
				`Continue until the following condition is satisfied: ${customCondition}. ` +
				"When it is satisfied, call the signal_loop_success tool."
			);
		}
		case "self":
			return "Continue until you are done. When finished, call the signal_loop_success tool.";
	}
}

function summarizeCondition(mode: LoopMode, condition?: string): string {
	switch (mode) {
		case "tests":
			return "tests pass";
		case "custom": {
			const summary = condition?.trim() || "custom condition";
			return summary.length > 48 ? `${summary.slice(0, 45)}...` : summary;
		}
		case "self":
			return "done";
	}
}

function getConditionText(mode: LoopMode, condition?: string): string {
	switch (mode) {
		case "tests":
			return "tests pass";
		case "custom":
			return condition?.trim() || "custom condition";
		case "self":
			return "you are done";
	}
}

function getCompactionInstructions(mode: LoopMode, condition?: string): string {
	const conditionText = getConditionText(mode, condition);
	return `Loop active. Breakout condition: ${conditionText}. Preserve this loop state and breakout condition in the summary.`;
}

function updateStatus(ctx: ExtensionContext, state: LoopStateData): void {
	if (!ctx.hasUI) return;
	if (!state.active || !state.mode) {
		ctx.ui.setWidget("loop", undefined);
		return;
	}
	const loopCount = state.loopCount ?? 0;
	const turnText = `(turn ${loopCount})`;
	const summary = state.summary?.trim();
	const text = summary
		? `Loop active: ${summary} ${turnText}`
		: `Loop active ${turnText}`;
	ctx.ui.setWidget("loop", [ctx.ui.theme.fg("accent", text)]);
}

async function loadState(ctx: ExtensionContext): Promise<LoopStateData> {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type: string; customType?: string; data?: LoopStateData };
		if (entry.type === "custom" && entry.customType === LOOP_STATE_ENTRY && entry.data) {
			return entry.data;
		}
	}
	return { active: false };
}

export default function loopExtension(pi: ExtensionAPI): void {
	let loopState: LoopStateData = { active: false };

	function persistState(state: LoopStateData): void {
		pi.appendEntry(LOOP_STATE_ENTRY, state);
	}

	function setLoopState(state: LoopStateData, ctx: ExtensionContext): void {
		loopState = state;
		persistState(state);
		updateStatus(ctx, state);
	}

	function clearLoopState(ctx: ExtensionContext): void {
		const cleared: LoopStateData = { active: false };
		loopState = cleared;
		persistState(cleared);
		updateStatus(ctx, cleared);
	}

	function breakLoop(ctx: ExtensionContext): void {
		clearLoopState(ctx);
		ctx.ui.notify("Loop ended", "info");
	}

	function wasLastAssistantAborted(messages: Array<{ role?: string; stopReason?: string }>): boolean {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message?.role === "assistant") {
				return message.stopReason === "aborted";
			}
		}
		return false;
	}

	function triggerLoopPrompt(ctx: ExtensionContext): void {
		if (!loopState.active || !loopState.mode || !loopState.prompt) return;
		if (ctx.hasPendingMessages()) return;

		const loopCount = (loopState.loopCount ?? 0) + 1;
		loopState = { ...loopState, loopCount };
		persistState(loopState);
		updateStatus(ctx, loopState);

		pi.sendMessage({
			customType: "loop",
			content: loopState.prompt,
			display: true
		}, {
			deliverAs: "followUp",
			triggerTurn: true
		});
	}

	async function showLoopSelector(ctx: ExtensionContext): Promise<LoopStateData | null> {
		const label = await ctx.ui.select("Select a loop preset", LOOP_PRESETS.map((preset) => preset.label));
		const selection = LOOP_PRESETS.find((preset) => preset.label === label)?.value;

		if (!selection) return null;

		switch (selection) {
			case "tests":
				return { active: true, mode: "tests", prompt: buildPrompt("tests") };
			case "self":
				return { active: true, mode: "self", prompt: buildPrompt("self") };
			case "custom": {
				const condition = await ctx.ui.editor("Enter loop breakout condition:", "");
				if (!condition?.trim()) return null;
				return {
					active: true,
					mode: "custom",
					condition: condition.trim(),
					prompt: buildPrompt("custom", condition.trim()),
				};
			}
			default:
				return null;
		}
	}

	function parseArgs(args: string | undefined): LoopStateData | null {
		if (!args?.trim()) return null;
		const parts = args.trim().split(/\s+/);
		const mode = parts[0]?.toLowerCase();

		switch (mode) {
			case "tests":
				return { active: true, mode: "tests", prompt: buildPrompt("tests") };
			case "self":
				return { active: true, mode: "self", prompt: buildPrompt("self") };
			case "custom": {
				const condition = parts.slice(1).join(" ").trim();
				if (!condition) return null;
				return {
					active: true,
					mode: "custom",
					condition,
					prompt: buildPrompt("custom", condition),
				};
			}
			default:
				return null;
		}
	}

	pi.registerTool({
		name: "signal_loop_success",
		label: "Signal Loop Success",
		description: "Stop the active loop when the breakout condition is satisfied. Only call this tool when explicitly instructed to do so by the user, tool or system prompt.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!loopState.active) {
				return {
					content: [{ type: "text", text: "No active loop is running." }],
					details: { active: false },
				};
			}

			clearLoopState(ctx);

			return {
				content: [{ type: "text", text: "Loop ended." }],
				details: { active: false },
			};
		},
	});

	pi.registerCommand("loop", {
		description: "Start a follow-up loop until a breakout condition is met",
		handler: async (args, ctx) => {
			let nextState = parseArgs(args);
			if (!nextState) {
				if (!ctx.hasUI) {
					ctx.ui.notify("Usage: /loop tests | /loop custom <condition> | /loop self", "warning");
					return;
				}
				nextState = await showLoopSelector(ctx);
			}

			if (!nextState) {
				ctx.ui.notify("Loop cancelled", "info");
				return;
			}

			if (loopState.active) {
				const confirm = ctx.hasUI
					? await ctx.ui.confirm("Replace active loop?", "A loop is already active. Replace it?")
					: true;
				if (!confirm) {
					ctx.ui.notify("Loop unchanged", "info");
					return;
				}
			}

			const summarizedState: LoopStateData = {
				...nextState,
				summary: summarizeCondition(nextState.mode!, nextState.condition),
				loopCount: 0,
			};
			setLoopState(summarizedState, ctx);
			ctx.ui.notify("Loop active", "info");
			triggerLoopPrompt(ctx);
		},
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!loopState.active) return;

		if (ctx.hasUI && wasLastAssistantAborted(event.messages)) {
			const confirm = await ctx.ui.confirm(
				"Break active loop?",
				"Operation aborted. Break out of the loop?",
			);
			if (confirm) {
				breakLoop(ctx);
				return;
			}
		}

		triggerLoopPrompt(ctx);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (!loopState.active || !loopState.mode || !ctx.model) return;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok) return;

		const instructionParts = [event.customInstructions, getCompactionInstructions(loopState.mode, loopState.condition)]
			.filter(Boolean)
			.join("\n\n");

		try {
			const compaction = await compact(
				event.preparation,
				ctx.model,
				auth.apiKey ?? "",
				auth.headers,
				instructionParts,
				event.signal,
			);
			return { compaction };
		} catch (error) {
			if (ctx.hasUI) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Loop compaction failed: ${message}`, "warning");
			}
			return;
		}
	});

	async function restoreLoopState(ctx: ExtensionContext): Promise<void> {
		loopState = await loadState(ctx);
		if (loopState.active && loopState.mode && !loopState.summary) {
			loopState = { ...loopState, summary: summarizeCondition(loopState.mode, loopState.condition) };
			persistState(loopState);
		}
		updateStatus(ctx, loopState);
	}

	pi.on("session_start", async (_event, ctx) => {
		await restoreLoopState(ctx);
	});

}
