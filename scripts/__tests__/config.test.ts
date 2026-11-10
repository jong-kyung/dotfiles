import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "..", "config.mjs");
const readonlyHook = 'bun "$HOME/.claude/hooks/readonly-gh-api.ts"';
const foreignHook = { type: "command", command: "other-app-hook" };

function applyClaude(file: string) {
	const result = spawnSync("node", [script, "claude", file], { encoding: "utf8" });
	expect(result.status).toBe(0);
	writeFileSync(file, result.stdout);
	return JSON.parse(result.stdout);
}

test("claude merge keeps foreign hooks, drops legacy hooks, and adds the guard once", () => {
	const file = join(mkdtempSync(join(tmpdir(), "config-test-")), "settings.json");
	writeFileSync(file, JSON.stringify({
		hooks: {
			PreToolUse: [{ matcher: "Bash", hooks: [foreignHook, { type: "command", command: readonlyHook }] }],
			Stop: [{ hooks: [{ type: "command", command: 'bun "$HOME/.claude/hooks/notify.ts"' }] }],
		},
	}));

	applyClaude(file);
	const { hooks } = applyClaude(file);

	const commands = hooks.PreToolUse.flatMap((group: { hooks: { command: string }[] }) => group.hooks.map((hook) => hook.command));
	expect(commands).toContain(foreignHook.command);
	expect(commands.filter((command: string) => command === readonlyHook)).toHaveLength(1);
	expect(hooks.Stop).toBeUndefined();
});
