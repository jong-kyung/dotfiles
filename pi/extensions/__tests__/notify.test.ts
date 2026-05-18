import { beforeEach, describe, expect, test } from "bun:test";
import notifyExtension, {
	detectTerminalNotification,
	encodeOsc777Notification,
	encodeOsc99Notification,
	encodeTerminalNotification,
	notificationBody,
	questionFromAskUserInput,
	registerTerminalNotifications,
	sanitizeOsc777Payload,
	subagentCompletionBody,
} from "../notify";

const unsubscribeStoreKey = "__notify_subagent_async_complete_unsubscribe__";

type Handler = (event: any) => unknown;

function makePi() {
	const handlers = new Map<string, Handler[]>();
	const eventHandlers = new Map<string, Handler[]>();

	return {
		pi: {
			on(name: string, handler: Handler) {
				handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			},
			events: {
				on(name: string, handler: Handler) {
					eventHandlers.set(name, [...(eventHandlers.get(name) ?? []), handler]);
					return () => {
						eventHandlers.set(name, (eventHandlers.get(name) ?? []).filter((candidate) => candidate !== handler));
					};
				},
			},
		} as any,
		emit(name: string, event: any) {
			for (const handler of handlers.get(name) ?? []) handler(event);
		},
		emitEvent(name: string, event: any) {
			for (const handler of eventHandlers.get(name) ?? []) handler(event);
		},
		eventHandlerCount(name: string) {
			return eventHandlers.get(name)?.length ?? 0;
		},
	};
}

function register(env: Record<string, string | undefined> = { TERM_PROGRAM: "WarpTerminal" }) {
	const writes: string[] = [];
	const pi = makePi();
	registerTerminalNotifications(pi.pi, { env, write: (payload) => writes.push(payload) });
	return { ...pi, writes };
}

beforeEach(() => {
	delete (globalThis as Record<string, unknown>)[unsubscribeStoreKey];
});

describe("notification body helpers", () => {
	test("collapses and truncates the last assistant text content", () => {
		const longText = `${"hello ".repeat(40)}done`;
		const body = notificationBody([
			{ role: "assistant", content: "older" },
			{ role: "user", content: "prompt" },
			{ role: "assistant", content: [{ type: "text", text: `latest\n${longText}` }] },
		]);

		expect(body).toStartWith("latest hello hello");
		expect(body).not.toContain("\n");
		expect([...body].length).toBe(180);
	});

	test("falls back when assistant content is empty or malformed", () => {
		expect(notificationBody([{ role: "assistant", content: [{ type: "tool_use", input: {} }] }])).toBe("Ready for input");
		expect(notificationBody(undefined)).toBe("Ready for input");
		expect(notificationBody({ role: "assistant", content: "not an array" })).toBe("Ready for input");
		expect(notificationBody([{ role: "assistant", content: [null, { type: "text", text: "safe" }] }])).toBe("safe");
	});

	test("extracts ask-user questions and falls back for unusable input", () => {
		expect(questionFromAskUserInput({ question: "  Approve this?  " })).toBe("Approve this?");
		expect(questionFromAskUserInput({ prompt: "missing" })).toBe("User input needed");
		expect(questionFromAskUserInput(null)).toBe("User input needed");
	});

	test("summarizes async subagent completed, failed, and paused status", () => {
		expect(subagentCompletionBody({ agent: "reviewer", success: true, taskIndex: 1, totalTasks: 3, summary: "Looks good" })).toEqual({
			title: "Subagent completed",
			body: "reviewer (2/3): Looks good",
		});
		expect(subagentCompletionBody({ agent: "tester", success: false, summary: "Tests failed" }).title).toBe("Subagent failed");
		expect(subagentCompletionBody({ agent: "worker", success: false, exitCode: 0, summary: "Paused after interrupt." }).title).toBe("Subagent paused");
	});
});

describe("terminal detection and encoding", () => {
	test("selects supported terminal families from distinctive signals", () => {
		expect(detectTerminalNotification({ TERM_PROGRAM: "WarpTerminal" })).toMatchObject({ family: "warp", protocol: "osc777" });
		expect(detectTerminalNotification({ TERM: "xterm-ghostty", GHOSTTY_RESOURCES_DIR: "/app" })).toMatchObject({ family: "ghostty", protocol: "osc9" });
		expect(detectTerminalNotification({ WEZTERM_PANE: "1" })).toMatchObject({ family: "wezterm", protocol: "osc777" });
		expect(detectTerminalNotification({ TERM_PROGRAM: "iTerm.app" })).toMatchObject({ family: "iterm2", protocol: "osc9" });
		expect(detectTerminalNotification({ KITTY_WINDOW_ID: "7" })).toMatchObject({ family: "kitty", protocol: "osc99" });
		expect(detectTerminalNotification({ TERM: "rxvt-unicode-256color" })).toMatchObject({ family: "rxvt", protocol: "osc777" });
	});

	test("fails closed for generic, remote-only, multiplexer-only, and conflicting signals", () => {
		expect(detectTerminalNotification({ TERM: "xterm-256color" })).toMatchObject({ family: "unsupported", protocol: "none" });
		expect(detectTerminalNotification({ TERM_PROGRAM: "Apple_Terminal" })).toMatchObject({ family: "unsupported", protocol: "none" });
		expect(detectTerminalNotification({ TMUX: "/tmp/tmux", TERM: "screen-256color" })).toMatchObject({ family: "unsupported", protocol: "none" });
		expect(detectTerminalNotification({ SSH_TTY: "/dev/ttys001", TERM: "xterm-256color" })).toMatchObject({ family: "unsupported", protocol: "none" });
		expect(detectTerminalNotification({ TERM_PROGRAM: "WarpTerminal", KITTY_WINDOW_ID: "1" })).toMatchObject({ family: "unsupported", protocol: "none" });
	});

	test("allows a strong terminal signal inside a multiplexer as best effort", () => {
		expect(detectTerminalNotification({ TMUX: "/tmp/tmux", TERM_PROGRAM: "WarpTerminal", TERM: "screen-256color" })).toMatchObject({ family: "warp", protocol: "osc777" });
	});

	test("treats inherited Warp shell session markers as weaker than current terminal signals", () => {
		expect(detectTerminalNotification({ KITTY_WINDOW_ID: "7", WARP_IS_LOCAL_SHELL_SESSION: "1" })).toMatchObject({ family: "kitty", protocol: "osc99" });
		expect(detectTerminalNotification({ WARP_IS_LOCAL_SHELL_SESSION: "1" })).toMatchObject({ family: "warp", protocol: "osc777" });
	});

	test("sanitizes controls and separators that could break OSC framing", () => {
		const c1Controls = "\u0080\u0090\u009b\u009c\u009d\u009e\u009f";
		const payload = encodeOsc777Notification(`Title;\n\x1b]99${c1Controls}`, `Body;\r\x07${c1Controls}next`);

		expect(payload).toBe("\x1b]777;notify;Title ]99;Body next\x07");
		expect(sanitizeOsc777Payload("safe;\ntext")).toBe("safe text");
		expect(encodeTerminalNotification({ family: "ghostty", protocol: "osc9", reason: "test" }, `Pi${c1Controls}`, `Ready${c1Controls}`)).toBe("\x1b]9;Pi: Ready\x07");
		expect(encodeOsc99Notification(`Pi${c1Controls}`, `Ready${c1Controls}`, 42)).not.toContain("\u009c");
	});

	test("truncates long unicode payloads without splitting characters", () => {
		const body = "🙂".repeat(100);
		const payload = encodeOsc777Notification("Pi", body);
		const encodedBody = payload.match(/notify;Pi;(.*)\x07/)?.[1] ?? "";

		expect(Buffer.byteLength(encodedBody, "utf8")).toBeLessThanOrEqual(240);
		expect(encodedBody).toEndWith("🙂");
	});

	test("encodes one selected protocol path", () => {
		expect(encodeTerminalNotification({ family: "ghostty", protocol: "osc9", reason: "test" }, "Pi", "Ready")).toBe("\x1b]9;Pi: Ready\x07");
		expect(encodeOsc99Notification("Pi", "Ready", 42)).toBe("\x1b]99;i=42:d=0:p=title;Pi\x1b\\\x1b]99;i=42:d=1:p=body;Ready\x1b\\");
		expect(encodeTerminalNotification({ family: "unsupported", protocol: "none", reason: "test" }, "Pi", "Ready")).toBeUndefined();
	});
});

describe("extension event wiring", () => {
	test("agent_end emits exactly one selected notification", () => {
		const { emit, writes } = register({ TERM_PROGRAM: "WarpTerminal" });

		emit("agent_end", { messages: [{ role: "assistant", content: "Done" }] });

		expect(writes).toHaveLength(1);
		expect(writes[0]).toBe("\x1b]777;notify;Pi;Done\x07");
	});

	test("ask-user tool calls notify and other tool calls do not", () => {
		const { emit, writes } = register({ TERM: "xterm-ghostty" });

		emit("tool_call", { toolName: "bash", input: { question: "Ignore?" } });
		emit("tool_call", { toolName: "ask_user", input: { question: "Choose one" } });
		emit("tool_call", { toolName: "ask_user_question", input: { question: "Choose another" } });

		expect(writes).toEqual([
			"\x1b]9;Pi needs your input: Choose one\x07",
			"\x1b]9;Pi needs your input: Choose another\x07",
		]);
	});

	test("async subagent status emits through the selected path", () => {
		const { emitEvent, writes } = register({ KITTY_WINDOW_ID: "9" });

		emitEvent("subagent:async-complete", { agent: "builder", success: false, state: "paused", taskIndex: 0, totalTasks: 2 });

		expect(writes).toHaveLength(1);
		expect(writes[0]).toContain("Subagent paused");
		expect(writes[0]).toContain("builder (1/2)");
		expect(writes[0]).toStartWith("\x1b]99;");
	});

	test("unsupported terminals produce no output for all event sources", () => {
		const { emit, emitEvent, writes } = register({ TERM: "xterm-256color" });

		emit("agent_end", { messages: [{ role: "assistant", content: "Done" }] });
		emit("tool_call", { toolName: "ask_user", input: { question: "Choose" } });
		emitEvent("subagent:async-complete", { success: true });

		expect(writes).toEqual([]);
	});

	test("default export registers the production event handlers", () => {
		const writes: string[] = [];
		const pi = makePi();
		const originalWrite = process.stdout.write;
		const originalTermProgram = process.env.TERM_PROGRAM;
		process.env.TERM_PROGRAM = "WarpTerminal";
		process.stdout.write = ((payload: string) => {
			writes.push(payload);
			return true;
		}) as typeof process.stdout.write;
		try {
			notifyExtension(pi.pi);
			pi.emit("agent_end", { messages: [{ role: "assistant", content: "Done" }] });
		} finally {
			process.stdout.write = originalWrite;
			if (originalTermProgram === undefined) delete process.env.TERM_PROGRAM;
			else process.env.TERM_PROGRAM = originalTermProgram;
		}

		expect(writes).toEqual(["\x1b]777;notify;Pi;Done\x07"]);
	});

	test("notification write failures are isolated from event handlers", () => {
		const pi = makePi();
		registerTerminalNotifications(pi.pi, { env: { TERM_PROGRAM: "WarpTerminal" }, write: () => { throw new Error("closed"); } });

		expect(() => pi.emit("agent_end", { messages: [{ role: "assistant", content: "Done" }] })).not.toThrow();
		expect(() => pi.emit("tool_call", { toolName: "ask_user", input: { question: "Choose" } })).not.toThrow();
		expect(() => pi.emitEvent("subagent:async-complete", { success: true })).not.toThrow();
	});

	test("extension reload unsubscribes stale async handlers", () => {
		const first = register({ TERM_PROGRAM: "WarpTerminal" });
		expect(first.eventHandlerCount("subagent:async-complete")).toBe(1);

		const second = register({ TERM_PROGRAM: "WarpTerminal" });
		expect(first.eventHandlerCount("subagent:async-complete")).toBe(0);
		expect(second.eventHandlerCount("subagent:async-complete")).toBe(1);

		first.emitEvent("subagent:async-complete", { success: true, agent: "old" });
		second.emitEvent("subagent:async-complete", { success: true, agent: "new" });

		expect(first.writes).toEqual([]);
		expect(second.writes).toHaveLength(1);
		expect(second.writes[0]).toContain("new");
	});
});
