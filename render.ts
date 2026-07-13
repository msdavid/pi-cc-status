/**
 * Renderers for pi-cc-status.
 *
 * Two render paths, selected by `config.command`:
 *   - default (in-process): a segment registry rendered via pi theme colors.
 *   - command (Claude-Code-style): spawns the user's script, feeds JSON on
 *     stdin, displays stdout lines. Implemented by `CommandRunner`.
 *
 * Both paths return `string[]` (one element per footer row) from `render(width)`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Config, SegmentId } from "./config.ts";
import { getLastAssistantUsage, getSessionCost, getSessionDurationMs, dirName, type GitCache } from "./data.ts";
import { gatherStatusData } from "./data.ts";

/** Shared mutable state between the footer factory, event handlers, and render(). */
export interface StatusState {
	git: GitCache;
	tui: TUI | null;
	theme: Theme | null;
	footerData: ReadonlyFooterDataProvider | null;
	/** Last viewport width seen by render(), used for COLUMNS env in command mode. */
	lastWidth: number;
}

export function freshState(): StatusState {
	return { git: { branch: null, dirty: false, untracked: false }, tui: null, theme: null, footerData: null, lastWidth: 80 };
}

/** Format a millisecond duration as a compact "Hh Mm"/"Mm Ss"/"Ss" string. */
function formatDuration(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const totalMin = Math.floor(totalSec / 60);
	const sec = totalSec % 60;
	if (totalMin < 60) return `${totalMin}m ${sec}s`;
	const hr = Math.floor(totalMin / 60);
	const min = totalMin % 60;
	return `${hr}h ${min}m`;
}

const SEGMENT_LABELS: Record<SegmentId, string> = {
	model: "Model:",
	dir: "Dir:",
	effort: "Effort:",
	context: "Context:",
	git: "Git:",
	session: "Session:",
	cost: "Cost:",
	duration: "Duration:",
	tokens: "Tokens:",
	version: "pi:",
	providers: "Providers:",
};

/** A segment renderer returns a colored string, or null to hide it. */
type SegmentRenderer = (ctx: ExtensionContext, pi: ExtensionAPI, footerData: ReadonlyFooterDataProvider, theme: Theme, config: Config, state: StatusState) => string | null;

function label(id: SegmentId, config: Config, theme: Theme): string {
	if (!config.accessibility.enabled || !config.accessibility.labels) return "";
	return theme.bold(`${SEGMENT_LABELS[id]} `);
}

/** Render a fixed-width bar gauge. Respects accessibility.plainBar. */
function barGauge(fraction: number, config: Config, theme: Theme): { filled: string; empty: string } {
	const clamped = Math.max(0, Math.min(1, fraction));
	const width = Math.max(1, config.bar.width);
	const filledCount = Math.round(clamped * width);
	const emptyCount = Math.max(0, width - filledCount);
	if (config.accessibility.enabled && config.accessibility.plainBar) {
		return { filled: "=".repeat(filledCount), empty: "-".repeat(emptyCount) };
	}
	return { filled: config.bar.filled.repeat(filledCount), empty: config.bar.empty.repeat(emptyCount) };
}

const SEGMENTS: Record<SegmentId, SegmentRenderer> = {
	model: (ctx, _pi, _fd, theme, config) => {
		const m = ctx.model;
		const text = m?.name ?? m?.id ?? "no-model";
		return label("model", config, theme) + theme.fg("accent", text);
	},
	dir: (ctx, _pi, _fd, theme, config) => label("dir", config, theme) + theme.fg("dim", dirName(ctx.cwd)),
	effort: (_ctx, pi, _fd, theme, config) => label("effort", config, theme) + theme.fg("dim", pi.getThinkingLevel()),
	context: (ctx, _pi, _fd, theme, config, state) => {
		const cu = ctx.getContextUsage();
		const usedPct = cu?.percent ?? 0;
		const { filled, empty } = barGauge(usedPct / 100, config, theme);
		const color = usedPct >= config.thresholds.error ? "error" : usedPct >= config.thresholds.warning ? "warning" : "accent";
		const bar = theme.fg(color, filled) + theme.fg("dim", empty);
		let seg = `${label("context", config, theme)}${bar} ${theme.fg("dim", `${Math.floor(usedPct)}%`)}`;
		if (config.showCachePercent) {
			const u = getLastAssistantUsage(ctx);
			if (u) {
				const totalInput = u.input + u.cacheWrite + u.cacheRead;
				const cachePct = totalInput > 0 ? Math.floor((u.cacheRead * 100) / totalInput) : 0;
				if (cachePct > 0) seg += theme.fg("dim", ` | ${cachePct}% cached`);
			}
		}
		return seg;
	},
	git: (_ctx, _pi, footerData, theme, config, state) => {
		const branch = state.git.branch ?? footerData.getGitBranch();
		if (!branch) return null;
		let status = "";
		if (state.git.dirty) status += "!";
		if (state.git.untracked) status += "?";
		const info = status ? `${branch} (${status})` : branch;
		return label("git", config, theme) + theme.fg("dim", info);
	},
	session: (_ctx, pi, _fd, theme, config) => {
		const name = pi.getSessionName();
		return name ? label("session", config, theme) + theme.fg("dim", name) : null;
	},
	cost: (ctx, _pi, _fd, theme, config) => {
		const cost = getSessionCost(ctx);
		if (cost <= 0) return null;
		return label("cost", config, theme) + theme.fg("dim", `$${cost.toFixed(4)}`);
	},
	duration: (ctx, _pi, _fd, theme, config) => {
		const ms = getSessionDurationMs(ctx);
		if (ms <= 0) return null;
		return label("duration", config, theme) + theme.fg("dim", formatDuration(ms));
	},
	tokens: (ctx, _pi, _fd, theme, config) => {
		const cu = ctx.getContextUsage();
		if (!cu?.tokens || !cu.contextWindow) return null;
		return label("tokens", config, theme) + theme.fg("dim", `${cu.tokens}/${cu.contextWindow}`);
	},
	version: (_ctx, _pi, _fd, theme, config) => {
		return label("version", config, theme) + theme.fg("dim", `v${VERSION}`);
	},
	providers: (_ctx, _pi, footerData, theme, config) => {
		const n = footerData.getAvailableProviderCount();
		return n > 0 ? label("providers", config, theme) + theme.fg("dim", `${n} providers`) : null;
	},
};

/** Default in-process renderer: joins configured segments with the separator. */
export function renderDefault(ctx: ExtensionContext, pi: ExtensionAPI, footerData: ReadonlyFooterDataProvider, theme: Theme, config: Config, state: StatusState, width: number): string[] {
	const segments: string[] = [];
	for (const id of config.segments) {
		const renderer = SEGMENTS[id];
		if (!renderer) continue;
		const seg = renderer(ctx, pi, footerData, theme, config, state);
		if (seg !== null) segments.push(seg);
	}
	const sep = theme.fg("muted", config.separator);
	const line = segments.join(sep);
	return [truncateToWidth(line, width)];
}

/**
 * CommandRunner: Claude-Code-style command mode. Spawns the user's command,
 * feeds the status JSON on stdin, captures stdout, caches lines for render().
 * Debounced 300ms; in-flight process is killed when a newer update fires.
 */
export class CommandRunner {
	private child: ChildProcess | null = null;
	private debounce: ReturnType<typeof setTimeout> | null = null;
	private lines: string[] = [];

	constructor(private config: Config, private state: StatusState) {}

	schedule(ctx: ExtensionContext, pi: ExtensionAPI, footerData: ReadonlyFooterDataProvider, tui: TUI): void {
		if (this.debounce) clearTimeout(this.debounce);
		this.debounce = setTimeout(() => {
			this.debounce = null;
			// run() is deferred, so the ctx it closed over may have gone stale
			// (session replacement/reload) by the time it fires. run() guards its
			// ctx access; .catch() keeps any residual rejection unhandled-proof.
			void this.run(ctx, pi, footerData, tui).catch(() => {});
		}, 300);
	}

	private async run(ctx: ExtensionContext, pi: ExtensionAPI, footerData: ReadonlyFooterDataProvider, tui: TUI): Promise<void> {
		// Cancel any in-flight execution.
		if (this.child) {
			this.child.kill();
			this.child = null;
		}
		const command = this.config.command;
		if (!command) return;
		// gatherStatusData and ctx.cwd access getters that throw once this ctx is
		// stale after session replacement/reload. This run may be deferred past
		// that point (debounce timer / cmdRefreshTimer), so bail silently — the
		// new session's runner renders fresh data via session_start.
		let json = "";
		let cwd = "";
		try {
			const data = gatherStatusData(ctx, pi, footerData, this.state.git);
			json = JSON.stringify(data);
			cwd = ctx.cwd;
		} catch {
			return;
		}
		const env = {
			...process.env,
			COLUMNS: String(this.state.lastWidth || 80),
			LINES: String(process.stdout.rows ?? 24),
		};
		try {
			const child = spawn(command, { shell: true, env, cwd, stdio: ["pipe", "pipe", "pipe"] });
			this.child = child;
			let out = "";
			// stdio streams emit 'error' events of their own (EPIPE when the
			// script exits without reading stdin, ERR_STREAM_DESTROYED after a
			// spawn failure). Unhandled they become an uncaughtException and
			// kill pi — child.on("error") does NOT cover them.
			const swallow = () => {};
			child.stdin?.on("error", swallow);
			child.stdout?.on("error", swallow);
			child.stderr?.on("error", swallow);
			child.stdout?.on("data", (d) => { out += d.toString(); });
			child.stderr?.on("data", () => { /* swallow; failures just yield no lines */ });
			child.on("error", () => { if (this.child === child) this.child = null; });
			child.on("close", () => {
				// Runs from a child-process event — a throw here would also be an
				// uncaughtException.
				try {
					if (this.child === child) this.child = null;
					const lines = out.split("\n");
					if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
					this.lines = lines;
					tui.requestRender();
				} catch {
					// Keep previous lines; never crash the host.
				}
			});
			child.stdin?.write(json);
			child.stdin?.end();
		} catch {
			this.lines = [];
		}
	}

	/** Lines for render(). Each is truncated to width by the caller. */
	getLines(width: number): string[] {
		return this.lines.map((l) => truncateToWidth(l, width));
	}

	dispose(): void {
		if (this.debounce) { clearTimeout(this.debounce); this.debounce = null; }
		if (this.child) { this.child.kill(); this.child = null; }
	}
}
