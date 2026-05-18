import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addUserSkillExclude, parseRemoveArgs } from "./index";

function tempSettingsPath(): string {
	const root = mkdtempSync(join(tmpdir(), "skill-manager-index-test-"));
	mkdirSync(root, { recursive: true });
	return join(root, "settings.json");
}

describe("Pi visibility settings override", () => {
	test("preserves existing skills entries when appending an exclude", () => {
		const settingsPath = tempSettingsPath();
		const objectEntry = { source: "local-skill", enabled: true };
		writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:pi-subagents"], skills: ["existing", objectEntry] }, null, "\t"));

		const result = addUserSkillExclude(settingsPath, "agent-browser");
		const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));

		expect(result.status).toBe("success");
		expect(result.changed).toBe(true);
		expect(result.requiresReload).toBe(true);
		expect(parsed.skills).toEqual(["existing", objectEntry, "-skills/agent-browser"]);
		expect(parsed.packages).toEqual(["npm:pi-subagents"]);
	});

	test("is idempotent but still requests reload", () => {
		const settingsPath = tempSettingsPath();
		writeFileSync(settingsPath, JSON.stringify({ skills: ["-skills/agent-browser"] }));

		const result = addUserSkillExclude(settingsPath, "agent-browser");
		const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));

		expect(result.status).toBe("success");
		expect(result.changed).toBe(false);
		expect(result.requiresReload).toBe(true);
		expect(parsed.skills).toEqual(["-skills/agent-browser"]);
	});

	test("fails closed on unsupported settings shapes", () => {
		const arraySettingsPath = tempSettingsPath();
		writeFileSync(arraySettingsPath, "[]");
		expect(addUserSkillExclude(arraySettingsPath, "agent-browser").status).toBe("failed");

		const skillsObjectPath = tempSettingsPath();
		writeFileSync(skillsObjectPath, JSON.stringify({ skills: { name: "agent-browser" } }));
		expect(addUserSkillExclude(skillsObjectPath, "agent-browser").status).toBe("failed");
	});
});

describe("remove argument parsing", () => {
	test("accepts --global in either position", () => {
		expect(parseRemoveArgs("agent-browser --global")).toEqual({ target: "agent-browser", npxRemoveMode: "global" });
		expect(parseRemoveArgs("--global agent-browser")).toEqual({ target: "agent-browser", npxRemoveMode: "global" });
	});
});
