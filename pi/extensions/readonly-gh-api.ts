import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function isUnsafeGhApi(command: string): boolean {
	return (
		/\bgh\s+api\b/.test(command) &&
		(/(?:^|\s)(?:-X(?:\s*|=)|--method(?:=|\s+))(?:POST|PATCH|PUT|DELETE)\b/i.test(command) ||
			/(?:^|\s)(?:-f|-F|--field|--raw-field|--input)(?:=|\s)/.test(command) ||
			/\bgh\s+api\s+graphql\b/.test(command))
	);
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event) => {
		if (event.toolName === "bash" && isUnsafeGhApi(String(event.input.command ?? ""))) {
			return { block: true, reason: "`gh api` is only allowed for readonly usage." };
		}
	});
}
