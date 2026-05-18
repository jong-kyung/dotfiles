import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

let rtkAvailable: boolean | undefined;

async function hasRtk(pi: ExtensionAPI, signal?: AbortSignal): Promise<boolean> {
	if (rtkAvailable !== undefined) return rtkAvailable;

	try {
		const result = await pi.exec("bash", ["-lc", "command -v rtk >/dev/null && rtk --version >/dev/null"], {
			signal,
			timeout: 2_000,
		});
		rtkAvailable = result.code === 0;
	} catch {
		rtkAvailable = false;
	}

	return rtkAvailable;
}

function shouldSkip(command: string): boolean {
	const trimmed = command.trimStart();
	return !trimmed || trimmed.startsWith("rtk ") || trimmed === "rtk";
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;

		const command = event.input.command;
		if (typeof command !== "string" || shouldSkip(command)) return;
		if (!(await hasRtk(pi, ctx.signal))) return;

		try {
			const result = await pi.exec("rtk", ["rewrite", command], {
				signal: ctx.signal,
				timeout: 2_000,
			});

			// Claude hook protocol: 0 = rewrite/allow, 1 = no equivalent,
			// 2 = deny/native handling, 3 = rewrite/ask. Pi has no native
			// permission popup, so both 0 and 3 safely become an input mutation.
			if ((result.code === 0 || result.code === 3) && result.stdout.trim()) {
				const rewritten = result.stdout.trimEnd();
				if (rewritten !== command) {
					event.input.command = rewritten;
				}
			}
		} catch {
			// Best effort only: if RTK fails, run the original command unchanged.
		}
	});
}
