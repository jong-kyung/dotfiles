import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type EnvSnapshot = Record<string, string | undefined>;
type WriteFn = (payload: string) => void;

export type NotificationProtocol = "osc777" | "osc9" | "osc99" | "none";
export type NotificationFamily = "warp" | "ghostty" | "wezterm" | "iterm2" | "kitty" | "rxvt" | "unsupported";

export interface TerminalSelection {
	family: NotificationFamily;
	protocol: NotificationProtocol;
	reason: string;
}

interface NotificationOptions {
	env?: EnvSnapshot;
	write?: WriteFn;
}

const TITLE_BYTE_LIMIT = 80;
const BODY_BYTE_LIMIT = 240;
const MESSAGE_BYTE_LIMIT = 320;
const SUBAGENT_UNSUBSCRIBE_KEY = "__notify_subagent_async_complete_unsubscribe__";

function hasValue(value: string | undefined, pattern: RegExp): boolean {
	return typeof value === "string" && pattern.test(value);
}

function truncateUtf8(input: string, maxBytes: number): string {
	let bytes = 0;
	let result = "";

	for (const char of input) {
		const length = Buffer.byteLength(char, "utf8");
		if (bytes + length > maxBytes) break;
		bytes += length;
		result += char;
	}

	return result;
}

function normalizePayload(payload: string, options: { replaceSemicolons?: boolean } = {}): string {
	const safePayload = options.replaceSemicolons ? payload.replace(/;/g, " ") : payload;

	return safePayload
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function sanitizeOsc777Payload(payload: string, maxBytes = BODY_BYTE_LIMIT): string {
	return truncateUtf8(normalizePayload(payload, { replaceSemicolons: true }), maxBytes);
}

export function sanitizeOscPayload(payload: string, maxBytes = BODY_BYTE_LIMIT): string {
	return truncateUtf8(normalizePayload(payload), maxBytes);
}

export function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.filter((block) => block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
		.map((block) => (block as { text: string }).text)
		.join(" ");
}

function truncateDisplayText(text: string, maxChars: number): string {
	return [...text].slice(0, maxChars).join("");
}

export function notificationBody(messages: unknown): string {
	const messageList = Array.isArray(messages) ? messages : [];
	const lastAssistant = [...messageList].reverse().find((message) => message && typeof message === "object" && (message as { role?: unknown }).role === "assistant");
	const text = textFromContent((lastAssistant as { content?: unknown } | undefined)?.content).replace(/\s+/g, " ").trim();

	return text ? truncateDisplayText(text, 180) : "Ready for input";
}

export function questionFromAskUserInput(input: unknown): string {
	if (!input || typeof input !== "object") return "User input needed";
	const question = (input as { question?: unknown }).question;
	return typeof question === "string" && question.trim() ? truncateDisplayText(question.trim(), 180) : "User input needed";
}

export function subagentCompletionBody(data: unknown): { title: string; body: string } {
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
		body: `${agent}${taskInfo}${summary ? `: ${truncateDisplayText(summary, 160)}` : ""}`,
	};
}

export function detectTerminalNotification(env: EnvSnapshot = process.env): TerminalSelection {
	const detected: Array<{ family: Exclude<NotificationFamily, "unsupported">; protocol: Exclude<NotificationProtocol, "none">; reason: string }> = [];

	if (env.KITTY_WINDOW_ID || hasValue(env.TERM, /kitty/i)) {
		detected.push({ family: "kitty", protocol: "osc99", reason: "kitty signal" });
	}

	if (env.TERM_PROGRAM === "WarpTerminal") {
		detected.push({ family: "warp", protocol: "osc777", reason: "warp signal" });
	}

	if (env.GHOSTTY_RESOURCES_DIR || env.GHOSTTY_BIN_DIR || hasValue(env.TERM_PROGRAM, /^ghostty$/i) || hasValue(env.TERM, /ghostty/i)) {
		detected.push({ family: "ghostty", protocol: "osc9", reason: "ghostty signal" });
	}

	if (env.WEZTERM_EXECUTABLE || env.WEZTERM_PANE || env.TERM_PROGRAM === "WezTerm") {
		detected.push({ family: "wezterm", protocol: "osc777", reason: "wezterm signal" });
	}

	if (env.TERM_PROGRAM === "iTerm.app") {
		detected.push({ family: "iterm2", protocol: "osc9", reason: "iterm2 signal" });
	}

	if (hasValue(env.TERM, /(^|-)rxvt|urxvt/i) || hasValue(env.COLORTERM, /rxvt|urxvt/i)) {
		detected.push({ family: "rxvt", protocol: "osc777", reason: "rxvt signal" });
	}

	if (detected.length === 0 && env.WARP_IS_LOCAL_SHELL_SESSION) {
		detected.push({ family: "warp", protocol: "osc777", reason: "warp shell session signal" });
	}

	const families = [...new Set(detected.map((signal) => signal.family))];
	if (families.length === 0) {
		return { family: "unsupported", protocol: "none", reason: "no supported terminal signal" };
	}
	if (families.length > 1) {
		return { family: "unsupported", protocol: "none", reason: `conflicting terminal signals: ${families.join(", ")}` };
	}

	return detected[0];
}

export function encodeOsc777Notification(title: string, body: string): string {
	return `\x1b]777;notify;${sanitizeOsc777Payload(title, TITLE_BYTE_LIMIT)};${sanitizeOsc777Payload(body, BODY_BYTE_LIMIT)}\x07`;
}

export function encodeOsc9Notification(title: string, body: string): string {
	const safeTitle = sanitizeOscPayload(title, TITLE_BYTE_LIMIT);
	const safeBody = sanitizeOscPayload(body, BODY_BYTE_LIMIT);
	const message = [safeTitle, safeBody].filter(Boolean).join(": ");
	return `\x1b]9;${truncateUtf8(message, MESSAGE_BYTE_LIMIT)}\x07`;
}

export function encodeOsc99Notification(title: string, body: string, id = 1): string {
	const notificationId = Math.max(1, Math.floor(id));
	const safeTitle = sanitizeOscPayload(title, TITLE_BYTE_LIMIT);
	const safeBody = sanitizeOscPayload(body, BODY_BYTE_LIMIT);
	return `\x1b]99;i=${notificationId}:d=0:p=title;${safeTitle}\x1b\\` +
		`\x1b]99;i=${notificationId}:d=1:p=body;${safeBody}\x1b\\`;
}

export function encodeTerminalNotification(selection: TerminalSelection, title: string, body: string, id?: number): string | undefined {
	if (selection.protocol === "osc777") return encodeOsc777Notification(title, body);
	if (selection.protocol === "osc9") return encodeOsc9Notification(title, body);
	if (selection.protocol === "osc99") return encodeOsc99Notification(title, body, id);
	return undefined;
}

let nextNotificationId = 0;

export function createTerminalNotifier(options: NotificationOptions = {}): (title: string, body: string) => void {
	const env = options.env ?? process.env;
	const write = options.write ?? ((payload: string) => process.stdout.write(payload));

	return (title: string, body: string) => {
		try {
			const selection = detectTerminalNotification(env);
			const payload = encodeTerminalNotification(selection, title, body, ++nextNotificationId);
			if (!payload) return;
			write(payload);
		} catch {
			// Notifications are best-effort and must not disrupt Pi event handling.
		}
	};
}

export function registerTerminalNotifications(pi: ExtensionAPI, options: NotificationOptions = {}) {
	const notify = createTerminalNotifier(options);

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "ask_user" && event.toolName !== "ask_user_question") return;
		notify("Pi needs your input", questionFromAskUserInput(event.input));
	});

	pi.on("agent_end", async (event) => {
		notify("Pi", notificationBody(event.messages));
	});

	const globalStore = globalThis as Record<string, unknown>;
	const previousUnsubscribe = globalStore[SUBAGENT_UNSUBSCRIBE_KEY];
	if (typeof previousUnsubscribe === "function") {
		try {
			previousUnsubscribe();
		} catch {
			// Best effort cleanup for stale handlers from an older reload.
		}
	}

	globalStore[SUBAGENT_UNSUBSCRIBE_KEY] = pi.events.on("subagent:async-complete", (data: unknown) => {
		const { title, body } = subagentCompletionBody(data);
		notify(title, body);
	});
}

export default function (pi: ExtensionAPI) {
	registerTerminalNotifications(pi);
}
