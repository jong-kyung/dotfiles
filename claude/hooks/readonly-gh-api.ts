// PreToolUse guard restricting `gh api` to readonly usage (port of pi's readonly-gh-api extension).
// Denies Bash commands that mutate via `gh api`: write methods (-X/--method POST|PATCH|PUT|DELETE),
// field flags (-f/-F/--field/--raw-field/--input, which make gh api default to POST), or `gh api graphql`.
import { readFileSync } from "node:fs";

export function isUnsafeGhApi(command: string): boolean {
	return (
		/\bgh\s+api\b/.test(command) &&
		(/(?:^|\s)(?:-X(?:\s*|=)|--method(?:=|\s+))(?:POST|PATCH|PUT|DELETE)\b/i.test(command) ||
			/(?:^|\s)(?:-f|-F|--field|--raw-field|--input)(?:=|\s)/.test(command) ||
			/\bgh\s+api\s+graphql\b/.test(command))
	);
}

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

if (input.tool_name === "Bash") {
	const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
	if (command && isUnsafeGhApi(command)) {
		deny("`gh api` is only allowed for readonly usage.");
	}
}
