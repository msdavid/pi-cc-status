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

import { basename, dirname, join, resolve } from "node:path";
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync, type Stats } from "node:fs";
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
		/** Nested LLM cost reported via pi's standard toolResult/compaction channel. */
		nested_cost_usd?: number;
		/** Cost from child sessions linked via the pi-core parentSession header. */
		child_session_cost_usd?: number;
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
	return getSessionCostBreakdown(ctx).total;
}

/**
 * Extract a finite cost number from a pi `Usage` object. Pi's Usage carries
 * `cost: { input, output, cacheRead, cacheWrite, total }`; some sources (e.g.
 * nested-work transcripts) use a bare number. Anything non-finite is 0.
 */
export function usageCostTotal(usage: unknown): number {
	if (!usage || typeof usage !== "object") return 0;
	const raw = (usage as { cost?: unknown }).cost;
	const value = typeof raw === "number" ? raw : typeof raw === "object" && raw !== null ? (raw as { total?: unknown }).total : undefined;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Cost breakdown for the current session tree. */
export interface SessionCostBreakdown {
	/** Assistant-message cost in the parent session branch. */
	own: number;
	/**
	 * Nested LLM cost reported through pi's standard channel: `usage` on
	 * toolResult entries (any tool that made nested model calls) plus
	 * compaction / branch-summary usage. Mirrors pi's native getSessionStats()
	 * semantics — extension-agnostic: any extension that reports nested usage
	 * is counted, absent extensions simply contribute nothing.
	 */
	nested: number;
	/** Cost from child session files linked via the `parentSession` header (pi-core field). */
	children: number;
	/** own + nested + children. */
	total: number;
}

/**
 * Compute the cost breakdown for the session. Never throws: a stale ctx
 * (session replacement/reload) or malformed entries degrade to zeros.
 */
export function getSessionCostBreakdown(ctx: ExtensionContext): SessionCostBreakdown {
	let own = 0;
	let nested = 0;
	try {
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type === "compaction" || e.type === "branch_summary") {
				nested += usageCostTotal((e as { usage?: unknown }).usage);
				continue;
			}
			if (e.type !== "message") continue;
			const role = (e.message as { role?: string }).role;
			if (role === "assistant") {
				own += usageCostTotal((e.message as AssistantMessage).usage);
			} else if (role === "toolResult") {
				nested += usageCostTotal((e.message as { usage?: unknown }).usage);
			}
		}
	} catch {
		// Stale ctx or unreadable branch — degrade to what we have.
	}
	let children = 0;
	try {
		children = getChildSessionsCost(ctx.sessionManager.getSessionFile());
	} catch {
		// Filesystem issues — children just contribute nothing.
	}
	return { own, nested, children, total: own + nested + children };
}

/*
 * Linked child-session cost scanning.
 *
 * pi-core writes a `parentSession` header field on sessions created via
 * /fork, /clone, or newSession({ parentSession }) — it is part of the session
 * format, not any extension's contract. Any agent that links its child
 * sessions through this field is therefore counted here automatically;
 * agents that don't (e.g. in-memory children) are invisible to a passive
 * reader and simply contribute nothing. All filesystem access is guarded.
 */

interface ChildFileRecord {
	mtimeMs: number;
	size: number;
	/** parentSession header value ("" when absent/unreadable). */
	parent: string;
	/** Cached full-file cost — only computed for linked children. */
	cost: number;
}

interface ChildScanCache {
	parentFile: string;
	dir: string;
	at: number;
	total: number;
	files: Map<string, ChildFileRecord>;
}

const CHILD_SCAN_TTL_MS = 2000;
const HEADER_PEEK_BYTES = 8192;

let childCache: ChildScanCache | null = null;

/** Read the session header (first JSONL line) of a session file. */
function readSessionHeader(path: string): { parentSession?: unknown } | null {
	let fd: number | undefined;
	try {
		// fs.openSync + read avoids reading multi-MB session files whole just
		// for the first line.
		fd = openSync(path, "r");
		const buf = Buffer.alloc(HEADER_PEEK_BYTES);
		const bytes = readSync(fd, buf, 0, buf.length, 0);
		const head = buf.subarray(0, bytes).toString("utf8");
		const nl = head.indexOf("\n");
		const line = nl === -1 ? head : head.slice(0, nl);
		const parsed = JSON.parse(line);
		return parsed && typeof parsed === "object" ? (parsed as { parentSession?: unknown }) : null;
	} catch {
		return null;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				/* ignore */
			}
		}
	}
}

/**
 * Sum usage cost over a whole session JSONL file, using the same entry
 * semantics as pi's native getSessionStats(): assistant + toolResult usage,
 * plus compaction / branch-summary usage.
 */
export function computeSessionFileCost(path: string): number {
	try {
		const content = readFileSync(path, "utf8");
		let total = 0;
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as {
					type?: string;
					usage?: unknown;
					message?: { role?: string; usage?: unknown };
				};
				if (entry.type === "compaction" || entry.type === "branch_summary") {
					total += usageCostTotal(entry.usage);
					continue;
				}
				if (entry.type !== "message" || !entry.message) continue;
				if (entry.message.role === "assistant" || entry.message.role === "toolResult") {
					total += usageCostTotal(entry.message.usage);
				}
			} catch {
				// Skip malformed lines.
			}
		}
		return total;
	} catch {
		return 0;
	}
}

/**
 * Total cost of all session files linked (transitively) to `parentSessionFile`
 * via the pi-core `parentSession` header. Cached: full rescans are throttled
 * to one per CHILD_SCAN_TTL_MS, and unchanged files (mtime+size) are not
 * re-parsed. Never throws.
 */
export function getChildSessionsCost(parentSessionFile: string | null | undefined): number {
	if (!parentSessionFile) return 0;
	const now = Date.now();
	const dir = dirname(parentSessionFile);
	if (childCache && childCache.parentFile === parentSessionFile && childCache.dir === dir && now - childCache.at < CHILD_SCAN_TTL_MS) {
		return childCache.total;
	}

	const files = childCache && childCache.parentFile === parentSessionFile && childCache.dir === dir ? childCache.files : new Map<string, ChildFileRecord>();

	try {
		const names = readdirSync(dir);
		const seen = new Set<string>();
		for (const name of names) {
			if (!name.endsWith(".jsonl")) continue;
			const path = join(dir, name);
			seen.add(path);
			let stat: Stats;
			try {
				stat = statSync(path);
			} catch {
				files.delete(path);
				continue;
			}
			const prev = files.get(path);
			if (prev && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) continue; // unchanged — reuse
			const header = readSessionHeader(path);
			const parent = typeof header?.parentSession === "string" ? header.parentSession : "";
			const isLinkedChild = parent !== "";
			const cost = isLinkedChild ? computeSessionFileCost(path) : 0;
			files.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, parent, cost });
		}
		// Forget files that disappeared.
		for (const path of files.keys()) {
			if (!seen.has(path)) files.delete(path);
		}

		// Walk the link graph transitively from the parent. Link comparison is
		// done on both the raw header string and the resolved absolute path, so
		// relative or differently-normalized headers still match. Each node is
		// processed exactly once (raw and resolved forms are aliases), so shared
		// children and cycles cannot double-count.
		let resolvedParent: string;
		try {
			resolvedParent = resolve(parentSessionFile);
		} catch {
			resolvedParent = parentSessionFile;
		}
		const stack = [parentSessionFile, resolvedParent];
		const processed = new Set<string>();
		let total = 0;
		for (;;) {
			const current = stack.pop();
			if (current === undefined) break;
			if (processed.has(current)) continue;
			processed.add(current);
			let resolvedCurrent: string;
			try {
				resolvedCurrent = resolve(current);
			} catch {
				resolvedCurrent = current;
			}
			if (resolvedCurrent !== current && processed.has(resolvedCurrent)) continue;
			processed.add(resolvedCurrent);
			for (const [path, rec] of files) {
				if (rec.parent !== current && rec.parent !== resolvedCurrent) continue;
				total += rec.cost;
				if (!processed.has(path)) stack.push(path);
			}
		}

		childCache = { parentFile: parentSessionFile, dir, at: now, total, files };
		return total;
	} catch {
		// Unreadable directory — cache the zero so we don't rescan every render.
		childCache = { parentFile: parentSessionFile, dir, at: now, total: 0, files };
		return 0;
	}
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
	const costs = getSessionCostBreakdown(ctx);

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
			total_cost_usd: costs.total,
			nested_cost_usd: costs.nested,
			child_session_cost_usd: costs.children,
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
