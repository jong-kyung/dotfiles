// Standalone Claude Code notification hook (no pi dependency).
// Reads the hook event JSON from stdin and emits one native terminal notification.
// Writes to /dev/tty because Claude Code captures hook stdout; stays silent when
// the terminal is unsupported, signals conflict, or no tty is available.
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";

type Protocol = "osc777" | "osc9" | "osc99";

const TITLE_LIMIT = 80;
const BODY_LIMIT = 240;
const MESSAGE_LIMIT = 320;

function detectProtocol(env = process.env): Protocol | undefined {
	const detected = new Set<Protocol>();
	if (env.KITTY_WINDOW_ID || /kitty/i.test(env.TERM ?? "")) detected.add("osc99");
	if (env.TERM_PROGRAM === "WarpTerminal" || env.TERM_PROGRAM === "WezTerm" || env.WEZTERM_EXECUTABLE || env.WEZTERM_PANE) detected.add("osc777");
	if (env.GHOSTTY_RESOURCES_DIR || env.GHOSTTY_BIN_DIR || /ghostty/i.test(env.TERM_PROGRAM ?? "") || /ghostty/i.test(env.TERM ?? "") || env.TERM_PROGRAM === "iTerm.app") detected.add("osc9");
	return detected.size === 1 ? [...detected][0] : undefined;
}

function sanitize(text: string, maxBytes: number, stripSemicolons = false): string {
	let safe = (stripSemicolons ? text.replace(/;/g, " ") : text)
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	while (Buffer.byteLength(safe, "utf8") > maxBytes) safe = [...safe].slice(0, -1).join("");
	return safe;
}

function encode(protocol: Protocol, title: string, body: string): string {
	if (protocol === "osc777") {
		return `\x1b]777;notify;${sanitize(title, TITLE_LIMIT, true)};${sanitize(body, BODY_LIMIT, true)}\x07`;
	}
	if (protocol === "osc99") {
		return `\x1b]99;i=1:d=0:p=title;${sanitize(title, TITLE_LIMIT)}\x1b\\\x1b]99;i=1:d=1:p=body;${sanitize(body, BODY_LIMIT)}\x1b\\`;
	}
	return `\x1b]9;${sanitize(`${title}: ${body}`, MESSAGE_LIMIT)}\x07`;
}

function lastAssistantText(path: unknown): string {
	if (typeof path !== "string" || !path) return "";
	try {
		const lines = readFileSync(path, "utf8").trim().split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			try {
				const message = JSON.parse(lines[i]).message;
				if (message?.role !== "assistant") continue;
				const content = message.content;
				const text = typeof content === "string"
					? content
					: (Array.isArray(content) ? content : [])
						.filter((block: unknown) => (block as { type?: string })?.type === "text")
						.map((block: unknown) => (block as { text: string }).text)
						.join(" ");
				const trimmed = text.replace(/\s+/g, " ").trim();
				if (trimmed) return [...trimmed].slice(0, 180).join("");
			} catch {
				// Skip malformed transcript lines.
			}
		}
	} catch {
		// Missing/unreadable transcript falls through to the default body.
	}
	return "";
}

function openTty(): number | undefined {
	try {
		return openSync("/dev/tty", "w");
	} catch {
		// Claude Code spawns hooks without a controlling terminal, so /dev/tty fails
		// with ENXIO. Walk up the process tree to the nearest ancestor that has a tty
		// (normally the Claude Code process attached to the user's terminal).
		let pid = process.ppid;
		for (let depth = 0; depth < 10 && pid > 1; depth++) {
			const out = spawnSync("ps", ["-o", "tty=,ppid=", "-p", String(pid)], { encoding: "utf8" }).stdout?.trim();
			if (!out) return undefined;
			const [tty, ppid] = out.split(/\s+/);
			if (tty && tty !== "??") {
				try {
					return openSync(`/dev/${tty}`, "w");
				} catch {
					return undefined;
				}
			}
			pid = Number(ppid);
		}
		return undefined;
	}
}

let input: Record<string, unknown> = {};
try {
	input = JSON.parse(readFileSync(0, "utf8"));
} catch {
	process.exit(0);
}

const notifications: Record<string, [string, string]> = {
	Notification: [
		"Claude Code needs your input",
		typeof input.message === "string" && input.message.trim() ? input.message : "User input needed",
	],
	Stop: ["Claude Code", lastAssistantText(input.transcript_path) || "Ready for input"],
	SubagentStop: ["Claude Code subagent completed", lastAssistantText(input.transcript_path) || "Done"],
};

const notification = notifications[String(input.hook_event_name)];
const protocol = detectProtocol();
if (!notification || !protocol) process.exit(0);

const tty = openTty();
if (tty === undefined) process.exit(0);
try {
	writeSync(tty, encode(protocol, notification[0], notification[1]));
	closeSync(tty);
} catch {
	// Notifications are best-effort; never fail the hook.
}
