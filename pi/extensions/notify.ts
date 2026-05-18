import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function sanitize(payload: string): string {
	return payload.replace(/[;\n\r\x07\x1b]/g, " ").trim();
}

function notify(title: string, body: string): void {
	process.stdout.write(`\x1b]777;notify;${sanitize(title)};${sanitize(body)}\x07`);
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join(" ");
}

function notificationBody(messages: Array<any>): string {
	const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
	const text = textFromContent(lastAssistant?.content).replace(/\s+/g, " ").trim();
	return text ? text.slice(0, 180) : "Ready for input";
}

function questionFromAskUserInput(input: unknown): string {
	if (!input || typeof input !== "object") return "User input needed";
	const question = (input as { question?: unknown }).question;
	return typeof question === "string" && question.trim() ? question.trim() : "User input needed";
}

function subagentCompletionBody(data: unknown): { title: string; body: string } {
	const result = data && typeof data === "object" ? data as {
		agent?: unknown;
		success?: unknown;
		exitCode?: unknown;
		state?: unknown;
		summary?: unknown;
		taskIndex?: unknown;
		totalTasks?: unknown;
	} : {};

	const agent = typeof result.agent === "string" && result.agent.trim() ? result.agent.trim() : "subagent";
	const summary = typeof result.summary === "string" ? result.summary.replace(/\s+/g, " ").trim() : "";
	const paused = result.success === false && (
		result.exitCode === 0
		|| result.state === "paused"
		|| summary.startsWith("Paused after interrupt.")
	);
	const status = paused ? "paused" : result.success ? "completed" : "failed";
	const taskInfo = typeof result.taskIndex === "number" && typeof result.totalTasks === "number"
		? ` (${result.taskIndex + 1}/${result.totalTasks})`
		: "";

	return {
		title: `Subagent ${status}`,
		body: `${agent}${taskInfo}${summary ? `: ${summary.slice(0, 160)}` : ""}`,
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "ask_user" && event.toolName !== "ask_user_question") return;
		notify("Pi needs your input", questionFromAskUserInput(event.input).slice(0, 180));
	});

	pi.on("agent_end", async (event) => {
		notify("Pi", notificationBody(event.messages));
	});

	const unsubscribeStoreKey = "__warp_notify_subagent_async_complete_unsubscribe__";
	const globalStore = globalThis as Record<string, unknown>;
	const previousUnsubscribe = globalStore[unsubscribeStoreKey];
	if (typeof previousUnsubscribe === "function") {
		try {
			previousUnsubscribe();
		} catch {
			// Best effort cleanup for stale handlers from an older reload.
		}
	}

	globalStore[unsubscribeStoreKey] = pi.events.on("subagent:async-complete", (data: unknown) => {
		const { title, body } = subagentCompletionBody(data);
		notify(title, body);
	});
}
