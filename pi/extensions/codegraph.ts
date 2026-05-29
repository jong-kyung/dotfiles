import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	isToolCallEventType,
	truncateHead,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

const CODEGRAPH_ACTIONS = [
	"status",
	"init",
	"index",
	"sync",
	"query",
	"files",
	"context",
	"callers",
	"callees",
	"impact",
	"affected",
] as const;

const OUTPUT_FORMATS = new Set(["markdown", "json", "tree", "flat", "grouped"]);
const FILE_FORMATS = new Set(["tree", "flat", "grouped"]);
const CONTEXT_FORMATS = new Set(["markdown", "json"]);
const AUTO_SYNC_ACTIONS = new Set<CodegraphParamsType["action"]>([
	"query",
	"files",
	"context",
	"callers",
	"callees",
	"impact",
	"affected",
]);

const CodegraphParams = Type.Object({
	action: StringEnum(CODEGRAPH_ACTIONS, {
		description:
			"CodeGraph operation: status/init/index/sync/query/files/context/callers/callees/impact/affected",
	}),
	path: Type.Optional(Type.String({ description: "Project root path. Defaults to the current pi working directory." })),
	search: Type.Optional(Type.String({ description: "Search string for action=query." })),
	task: Type.Optional(Type.String({ description: "Task description for action=context." })),
	symbol: Type.Optional(Type.String({ description: "Symbol name for callers/callees/impact." })),
	files: Type.Optional(Type.Array(Type.String(), { description: "Source files for action=affected." })),
	kind: Type.Optional(Type.String({ description: "Optional query kind filter, e.g. function, class, method." })),
	limit: Type.Optional(Type.Number({ description: "Result limit for query/callers/callees." })),
	maxNodes: Type.Optional(Type.Number({ description: "Maximum nodes for action=context." })),
	maxCode: Type.Optional(Type.Number({ description: "Maximum code blocks for action=context." })),
	noCode: Type.Optional(Type.Boolean({ description: "For action=context, exclude code blocks." })),
	format: Type.Optional(Type.String({ description: "Output format: markdown/json for context, tree/flat/grouped for files." })),
	filter: Type.Optional(Type.String({ description: "Directory filter for files, or test glob filter for affected." })),
	pattern: Type.Optional(Type.String({ description: "Glob pattern for action=files." })),
	maxDepth: Type.Optional(Type.Number({ description: "Maximum tree depth for action=files." })),
	depth: Type.Optional(Type.Number({ description: "Traversal depth for action=impact or action=affected." })),
	force: Type.Optional(Type.Boolean({ description: "Force full re-index for action=index." })),
	quiet: Type.Optional(Type.Boolean({ description: "Suppress progress output for index/sync/affected." })),
	json: Type.Optional(Type.Boolean({ description: "Request JSON output when the CodeGraph command supports it." })),
	noMetadata: Type.Optional(Type.Boolean({ description: "Hide file metadata for action=files." })),
	initIndex: Type.Optional(Type.Boolean({ description: "Run initial indexing for action=init." })),
});

type CodegraphParamsType = {
	action: (typeof CODEGRAPH_ACTIONS)[number];
	path?: string;
	search?: string;
	task?: string;
	symbol?: string;
	files?: string[];
	kind?: string;
	limit?: number;
	maxNodes?: number;
	maxCode?: number;
	noCode?: boolean;
	format?: string;
	filter?: string;
	pattern?: string;
	maxDepth?: number;
	depth?: number;
	force?: boolean;
	quiet?: boolean;
	json?: boolean;
	noMetadata?: boolean;
	initIndex?: boolean;
};

type CodegraphDetails = {
	action: string;
	args: string[];
	path: string;
	exitCode: number;
	stderr?: string;
	autoSync?: {
		args: string[];
		exitCode: number;
		stderr?: string;
	};
	fullOutputPath?: string;
	truncated?: boolean;
};

function required(value: string | undefined, name: string, action: string): string {
	if (value && value.trim()) return value;
	throw new Error(`codegraph action=${action} requires parameter '${name}'`);
}

function positiveInteger(value: number | undefined, fallback: number): string {
	if (!Number.isFinite(value ?? NaN)) return String(fallback);
	return String(Math.max(1, Math.floor(value as number)));
}

function pushJson(args: string[], params: CodegraphParamsType) {
	if (params.json) args.push("--json");
}

function buildArgs(params: CodegraphParamsType, ctx: ExtensionContext): { args: string[]; projectPath: string } {
	const projectPath = params.path || ctx.cwd;
	const args: string[] = [params.action];

	switch (params.action) {
		case "status":
			pushJson(args, params);
			args.push(projectPath);
			break;

		case "init":
			if (params.initIndex) args.push("--index");
			args.push(projectPath);
			break;

		case "index":
			if (params.force) args.push("--force");
			if (params.quiet) args.push("--quiet");
			args.push(projectPath);
			break;

		case "sync":
			if (params.quiet) args.push("--quiet");
			args.push(projectPath);
			break;

		case "query":
			args.push("--path", projectPath);
			args.push("--limit", positiveInteger(params.limit, 20));
			if (params.kind) args.push("--kind", params.kind);
			pushJson(args, params);
			args.push("--", required(params.search, "search", params.action));
			break;

		case "files": {
			args.push("--path", projectPath);
			if (params.filter) args.push("--filter", params.filter);
			if (params.pattern) args.push("--pattern", params.pattern);
			if (params.format) {
				if (!FILE_FORMATS.has(params.format)) {
					throw new Error("action=files format must be one of: tree, flat, grouped");
				}
				args.push("--format", params.format);
			}
			if (params.maxDepth !== undefined) args.push("--max-depth", positiveInteger(params.maxDepth, 3));
			if (params.noMetadata) args.push("--no-metadata");
			pushJson(args, params);
			break;
		}

		case "context": {
			args.push("--path", projectPath);
			args.push("--max-nodes", positiveInteger(params.maxNodes, 50));
			args.push("--max-code", positiveInteger(params.maxCode, 10));
			if (params.noCode) args.push("--no-code");
			if (params.format) {
				if (!CONTEXT_FORMATS.has(params.format)) {
					throw new Error("action=context format must be one of: markdown, json");
				}
				args.push("--format", params.format);
			}
			args.push("--", required(params.task, "task", params.action));
			break;
		}

		case "callers":
		case "callees":
			args.push("--path", projectPath);
			args.push("--limit", positiveInteger(params.limit, 30));
			pushJson(args, params);
			args.push("--", required(params.symbol, "symbol", params.action));
			break;

		case "impact":
			args.push("--path", projectPath);
			args.push("--depth", positiveInteger(params.depth, 2));
			pushJson(args, params);
			args.push("--", required(params.symbol, "symbol", params.action));
			break;

		case "affected":
			args.push("--path", projectPath);
			if (params.depth !== undefined) args.push("--depth", positiveInteger(params.depth, 5));
			if (params.filter) args.push("--filter", params.filter);
			if (params.quiet) args.push("--quiet");
			pushJson(args, params);
			if (params.files?.length) args.push("--", ...params.files);
			break;

		default:
			throw new Error(`Unsupported CodeGraph action: ${(params as { action: string }).action}`);
	}

	if (params.format && !OUTPUT_FORMATS.has(params.format)) {
		throw new Error("format must be one of: markdown, json, tree, flat, grouped");
	}

	return { args, projectPath };
}

function timeoutFor(action: string): number {
	if (action === "init" || action === "index") return 10 * 60_000;
	if (action === "sync") return 3 * 60_000;
	if (action === "context" || action === "affected" || action === "impact") return 2 * 60_000;
	return 60_000;
}

async function truncateForTool(text: string): Promise<{ text: string; fullOutputPath?: string; truncated?: boolean }> {
	const truncation = truncateHead(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	if (!truncation.truncated) return { text };

	const tempDir = await mkdtemp(join(tmpdir(), "pi-codegraph-"));
	const tempFile = join(tempDir, "output.txt");
	await withFileMutationQueue(tempFile, async () => writeFile(tempFile, text, "utf8"));

	let content = truncation.content;
	content += `\n\n[CodeGraph output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
	content += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
	content += ` Full output saved to: ${tempFile}]`;

	return { text: content, fullOutputPath: tempFile, truncated: true };
}

function looksLikeSearchCommand(command: string): boolean {
	if (command.includes("codegraph")) return false;
	if (command.includes("PI_CODEGRAPH_ALLOW_SEARCH=1")) return false;
	return /(^|[\s;&|()])(?:rg|grep|ack|ag|fd|find)(?=\s|$)/.test(command) || /(^|[\s;&|()])git\s+grep(?=\s|$)/.test(command);
}

function strictSearchEnabled(pi: ExtensionAPI): boolean {
	return Boolean(pi.getFlag("codegraph-strict-search")) || process.env.PI_CODEGRAPH_STRICT_SEARCH === "1";
}

export default function codegraphExtension(pi: ExtensionAPI) {
	pi.registerFlag("codegraph-strict-search", {
		description:
			"Block bash grep/rg/find-style searches so the agent uses the codegraph tool first. Set PI_CODEGRAPH_ALLOW_SEARCH=1 before a command to bypass for exact text searches.",
		type: "boolean",
		default: false,
	});

	pi.registerTool({
		name: "codegraph",
		label: "CodeGraph",
		description:
			"Semantic codebase intelligence via the CodeGraph CLI. Use for task context, symbol search, callers/callees, impact analysis, indexed file structure, index status/sync, and affected-test discovery. Output is truncated to 2000 lines or 50KB.",
		promptSnippet: "Semantic codebase search, context building, call graph, impact, and affected-test analysis using CodeGraph",
		promptGuidelines: [
			"Use the `codegraph` tool before `bash` grep/rg/find when looking for code context, relevant files, symbols, callers/callees, impact, or affected tests.",
			"Use `codegraph` action=context at the start of non-trivial implementation/debugging tasks to gather semantic context, then use `read` on the exact files it identifies.",
			"Use `codegraph` action=callers/callees/impact before changing shared functions, classes, hooks, controllers, or model methods.",
			"Use exact text search (`grep`, `rg`, or built-in grep) when looking for literal error messages, config keys, text strings, or generated files that may not be indexed by CodeGraph.",
		],
		parameters: CodegraphParams,

		async execute(_toolCallId, params: CodegraphParamsType, signal, _onUpdate, ctx) {
			const { args, projectPath } = buildArgs(params, ctx);
			const syncArgs = ["sync", "--quiet", projectPath];
			const syncResult = AUTO_SYNC_ACTIONS.has(params.action)
				? await pi.exec("codegraph", syncArgs, {
						signal,
						timeout: timeoutFor("sync"),
					})
				: undefined;
			const result = await pi.exec("codegraph", args, {
				signal,
				timeout: timeoutFor(params.action),
			});

			let output = result.stdout || "";
			if (result.stderr?.trim()) {
				output += output ? `\n\n[stderr]\n${result.stderr}` : result.stderr;
			}
			if (!output.trim()) output = `(codegraph exited with code ${result.code}; no output)`;
			if (result.code !== 0) output = `[codegraph exited with code ${result.code}]\n${output}`;
			if (syncResult && syncResult.code !== 0) {
				const syncOutput = syncResult.stderr?.trim() || syncResult.stdout?.trim() || "no output";
				output = `[codegraph auto-sync exited with code ${syncResult.code}: ${syncOutput}]\n${output}`;
			}

			const truncated = await truncateForTool(output);
			const details: CodegraphDetails = {
				action: params.action,
				args,
				path: projectPath,
				exitCode: result.code ?? 0,
				stderr: result.stderr || undefined,
				autoSync: syncResult
					? {
							args: syncArgs,
							exitCode: syncResult.code ?? 0,
							stderr: syncResult.stderr || undefined,
						}
					: undefined,
				fullOutputPath: truncated.fullOutputPath,
				truncated: truncated.truncated,
			};

			return {
				content: [{ type: "text", text: truncated.text }],
				details,
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("codegraph"));
			if (args?.action) text += " " + theme.fg("accent", String(args.action));
			const target = args?.task || args?.search || args?.symbol;
			if (target) text += " " + theme.fg("muted", JSON.stringify(String(target).slice(0, 80)));
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Running CodeGraph..."), 0, 0);
			const details = result.details as CodegraphDetails | undefined;
			const status = details?.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("warning", `exit ${details?.exitCode ?? "?"}`);
			let text = `${status} CodeGraph ${details?.action ?? ""}`.trim();
			if (details?.autoSync && details.autoSync.exitCode !== 0) text += theme.fg("warning", " (auto-sync failed)");
			if (details?.truncated) text += theme.fg("warning", " (truncated)");
			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") text += `\n${theme.fg("toolOutput", content.text)}`;
				if (details?.fullOutputPath) text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
			}
			return new Text(text, 0, 0);
		},
	});

	pi.on("before_agent_start", async (event) => {
		const activeTools = event.systemPromptOptions.selectedTools ?? [];
		if (!activeTools.includes("codegraph")) return;

		return {
			systemPrompt: `${event.systemPrompt}\n\n## CodeGraph Context-Finding Policy\n\n- For code exploration, semantic context, symbol lookup, call graphs, impact analysis, or affected-test discovery, prefer the \`codegraph\` tool before shell \`grep\`, \`rg\`, \`find\`, or broad file listing.\n- Start non-trivial code changes with \`codegraph\` action=\`context\`, then inspect exact files with \`read\`.\n- Before changing shared symbols, use \`codegraph\` action=\`callers\`, \`callees\`, or \`impact\`.\n- After changing files, use \`codegraph\` action=\`affected\` to choose focused tests.\n- Still use exact text search for literal error messages, config keys, user-visible strings, or files that may not be indexed.\n`,
		};
	});

	pi.on("tool_call", async (event) => {
		if (!strictSearchEnabled(pi)) return;

		if (isToolCallEventType("bash", event)) {
			const command = event.input.command;
			if (typeof command === "string" && looksLikeSearchCommand(command)) {
				return {
					block: true,
					reason:
						"CodeGraph strict search mode is enabled. Use the `codegraph` tool first for code context/symbol/impact discovery. For exact literal searches, rerun the shell command with PI_CODEGRAPH_ALLOW_SEARCH=1 prefixed.",
				};
			}
		}

		if (event.toolName === "grep" || event.toolName === "find") {
			return {
				block: true,
				reason:
					"CodeGraph strict search mode is enabled. Use the `codegraph` tool first for code context/symbol/impact discovery; use grep/find only for exact literal or non-indexed searches.",
			};
		}
	});
}
