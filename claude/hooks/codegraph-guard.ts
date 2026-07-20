// PreToolUse guard enforcing the CodeGraph-first policy (port of pi's codegraph strict-search mode).
// Denies Grep tool calls and Bash search commands (rg/grep/ack/ag/fd/find/git grep).
// Escape hatch: prefix the shell command with ALLOW_SEARCH=1 for exact literal searches.
import { readFileSync } from "node:fs";

const SEARCH_COMMAND = /(^|[\s;&|()])(?:rg|grep|ack|ag|fd|find)(?=\s|$)/;
const GIT_GREP = /(^|[\s;&|()])git\s+grep(?=\s|$)/;

function deny(reason: string): never {
	console.log(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: reason,
			},
		}),
	);
	process.exit(0);
}

let input: Record<string, any> = {};
try {
	input = JSON.parse(readFileSync(0, "utf8"));
} catch {
	process.exit(0);
}

if (input.tool_name === "Grep") {
	deny(
		"CodeGraph-first policy: use the codegraph CLI (query/explore/callers/callees/impact) for code context and symbol discovery. For exact literal searches, use Bash with ALLOW_SEARCH=1 prefixed.",
	);
}

if (input.tool_name === "Bash") {
	const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
	if (
		command &&
		!command.includes("codegraph") &&
		!command.includes("ALLOW_SEARCH=1") &&
		(SEARCH_COMMAND.test(command) || GIT_GREP.test(command))
	) {
		deny(
			"CodeGraph-first policy: use the codegraph CLI first for code context/symbol/impact discovery. For exact literal searches, rerun this command with ALLOW_SEARCH=1 prefixed.",
		);
	}
}
