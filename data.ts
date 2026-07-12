/**
 * Data-access layer: builds a JSON object mirroring Claude Code's statusLine
 * stdin schema (https://code.claude.com/docs/en/statusline#available-data) as
 * closely as pi exposes, plus async git-status refresh.
 *
 * Two consumers:
 *   - command mode: the object is JSON-stringified and piped to the user's
 *     script on stdin, so existing Claude Code statusline scripts work verbatim.
 *   - default renderer: segments read the same object (cost/tokens accumulate
 *     here so render() stays cheap).
 *
 * Fields pi cannot provide are omitted (added_dirs, git_worktree, repo metadata,
 * rate_limits, prompt_id, output_style, vim.mode, agent.name, pr.*, worktree.*).
 * cost.total_api_duration_ms and lines_added/removed are not tracked by pi and
 * are reported as 0 where the schema expects a number.
 */

import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";

export interface GitCache {
	branch: string | null;
	dirty: boolean;
	untracked: boolean;
}

export const EMPTY_GIT: GitCache = { branch: null, dirty: false, untracked: false };

/** The JSON object handed to command-mode scripts (Claude Code schema subset). */
export interface StatusData {
	cwd: string;
	workspace: { current_dir: string; project_dir: string };
	session_id: string;
	session_name?: string;
	transcript_path?: string;
	model?: { id: string; display_name: string };
	version: string;
	context_window: {
		total_input_tokens: number;
		total_output_tokens: number;
		context_window_size: number;
		used_percentage: number | null;
		remaining_percentage: number | null;
		current_usage: {
			input_tokens: number;
			output_tokens: number;
			cache_creation_input_tokens: number;
			cache_read_input_tokens: number;
		} | null;
	};
	exceeds_200k_tokens: boolean;
	effort?: { level: string };
	thinking: { enabled: boolean };
	cost: {
		total_cost_usd: number;
		total_duration_ms: number;
		total_api_duration_ms: number;
		total_lines_added: number;
		total_lines_removed: number;
	};
	git?: { branch: string | null; dirty: boolean; untracked: boolean };
}

/** Find the most recent assistant message's usage in the session branch. */
export function getLastAssistantUsage(ctx: ExtensionContext): Usage | null {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (e.type === "message" && e.message.role === "assistant") {
			return (e.message as AssistantMessage).usage;
		}
	}
	return null;
}

/** Sum cost across all assistant messages in the branch (best-effort session total). */
export function getSessionCost(ctx: ExtensionContext): number {
	let total = 0;
	for (const e of ctx.sessionManager.getBranch()) {
		if (e.type === "message" && e.message.role === "assistant") {
			total += (e.message as AssistantMessage).usage.cost.total;
		}
	}
	return total;
}

/** Wall-clock duration since session start, from the session header timestamp. */
export function getSessionDurationMs(ctx: ExtensionContext): number {
	const header = ctx.sessionManager.getHeader();
	if (!header?.timestamp) return 0;
	const start = Date.parse(header.timestamp);
	if (Number.isNaN(start)) return 0;
	return Math.max(0, Date.now() - start);
}

/**
 * Build the status data object. Synchronous — git dirty/untracked comes from the
 * passed-in cache, refreshed in the background by `refreshGitStatus`.
 */
export function gatherStatusData(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	footerData: ReadonlyFooterDataProvider,
	git: GitCache,
): StatusData {
	const cwd = ctx.cwd;
	const usage = getLastAssistantUsage(ctx);
	const cu = ctx.getContextUsage();

	const totalInput = cu?.tokens ?? 0;
	const totalOutput = usage?.output ?? 0;
	const contextWindow = cu?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const usedPct = cu?.percent ?? null;

	const sessionName = pi.getSessionName() ?? ctx.sessionManager.getSessionName();
	const sessionFile = ctx.sessionManager.getSessionFile();

	const data: StatusData = {
		cwd,
		workspace: { current_dir: cwd, project_dir: cwd },
		session_id: ctx.sessionManager.getSessionId(),
		...(sessionName ? { session_name: sessionName } : {}),
		...(sessionFile ? { transcript_path: sessionFile } : {}),
		version: VERSION,
		context_window: {
			total_input_tokens: totalInput,
			total_output_tokens: totalOutput,
			context_window_size: contextWindow,
			used_percentage: usedPct,
			remaining_percentage: usedPct === null ? null : 100 - usedPct,
			current_usage: usage
				? {
						input_tokens: usage.input,
						output_tokens: usage.output,
						cache_creation_input_tokens: usage.cacheWrite,
						cache_read_input_tokens: usage.cacheRead,
					}
				: null,
		},
		exceeds_200k_tokens: totalInput + totalOutput > 200000,
		thinking: { enabled: pi.getThinkingLevel() !== "minimal" },
		cost: {
			total_cost_usd: getSessionCost(ctx),
			total_duration_ms: getSessionDurationMs(ctx),
			total_api_duration_ms: 0, // not tracked by pi
			total_lines_added: 0, // not tracked by pi
			total_lines_removed: 0, // not tracked by pi
		},
	};

	const model = ctx.model;
	if (model) {
		data.model = { id: model.id, display_name: model.name };
	}

	// effort.level — only when the model supports reasoning.
	if (model?.reasoning) {
		data.effort = { level: pi.getThinkingLevel() };
	}

	// git — branch from footerData (pi's watcher), dirty/untracked from cache.
	const branch = git.branch ?? footerData.getGitBranch();
	if (branch !== null) {
		data.git = { branch, dirty: git.dirty, untracked: git.untracked };
	}

	return data;
}

/**
 * Refresh git dirty/untracked flags via `pi.exec`. Branch comes from
 * footerData.onBranchChange; this only resolves the working-tree status markers.
 * Never throws — returns EMPTY_GIT on failure.
 */
export async function refreshGitStatus(pi: ExtensionAPI, cwd: string, prev: GitCache): Promise<GitCache> {
	try {
		const res = await pi.exec("git", ["status", "--porcelain=v1", "-z"], { cwd, timeout: 1500 });
		if (res.code !== 0) return { ...prev, dirty: false, untracked: false };
		let dirty = false;
		let untracked = false;
		const records = res.stdout.split("\0").filter((r) => r.length > 0);
		for (const rec of records) {
			const xy = rec.slice(0, 2);
			if (xy === "??") untracked = true;
			else dirty = true;
			if (dirty && untracked) break;
		}
		return { ...prev, dirty, untracked };
	} catch {
		return { ...prev, dirty: false, untracked: false };
	}
}

/** basename helper re-exported for renderers that don't import node:path. */
export function dirName(cwd: string): string {
	return basename(cwd) || cwd;
}
