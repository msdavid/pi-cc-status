/**
 * pi-cc-status — a Claude Code–style status line for the pi coding agent.
 *
 * Two render modes (selected by config.command):
 *   - default: in-process segment renderer (theme-integrated, configurable)
 *   - command: Claude-Code-style — spawns the user's script, feeds JSON on
 *     stdin, displays stdout. Existing Claude Code statusline scripts work.
 *
 * Config: ~/.pi/agent/cc-status/config.json (global) and/or
 * .pi/cc-status/config.json (project). See README for the schema.
 *
 * Commands: /cc-status (toggle), /cc-status:edit, /cc-status:reload.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "./config.ts";
import { loadConfig, globalConfigPath, defaultConfig } from "./config.ts";
import { refreshGitStatus, EMPTY_GIT } from "./data.ts";
import { renderDefault, CommandRunner, freshState, type StatusState } from "./render.ts";

export default function (pi: ExtensionAPI) {
	let enabled = false;
	let config: Config = defaultConfig();
	const state: StatusState = freshState();
	let gitTimer: ReturnType<typeof setInterval> | undefined;
	let cmdRefreshTimer: ReturnType<typeof setInterval> | undefined;
	let runner: CommandRunner | null = null;

	/** Re-read config and re-arm refresh timers. */
	function reload(ctx: ExtensionContext): void {
		config = loadConfig(ctx.cwd);
		armTimers(ctx);
		// Recreate the command runner if in command mode.
		if (config.command) {
			runner?.dispose();
			runner = new CommandRunner(config, state);
		} else {
			runner?.dispose();
			runner = null;
		}
	}

	/**
	 * Clamp a seconds value to a valid setInterval delay. Delays > 2^31-1 ms
	 * overflow and make Node fire the timer every 1ms — a config typo would
	 * busy-spin pi.
	 */
	function intervalDelay(seconds: number): number {
		return Math.min(seconds * 1000, 2 ** 31 - 1);
	}

	function armTimers(ctx: ExtensionContext): void {
		stopTimers();
		// cwd is immutable for a session's lifetime. Capture it as a string so the
		// interval never touches ctx.cwd (a getter that throws once this ctx goes
		// stale after session replacement/reload). pi.exec's stale throw is already
		// swallowed by refreshGitStatus's try/catch.
		const cwd = ctx.cwd;
		// Timer callbacks are bare Node timers: a synchronous throw escapes as an
		// uncaughtException and kills pi, so both bodies are wrapped.
		// Git dirty/untracked poll (default mode only — command mode gets it from data).
		if (!config.command && config.refreshSeconds > 0) {
			gitTimer = setInterval(() => {
				try {
					void refreshGitStatus(pi, cwd, state.git).then((g) => {
						state.git = g;
					});
					// Duration segment is time-based — tick the render while idle.
					if (config.segments.includes("duration")) requestRender();
				} catch {
					// Skip this tick; never crash the host.
				}
			}, intervalDelay(config.refreshSeconds));
			if (typeof gitTimer.unref === "function") gitTimer.unref();
		}
		// Command-mode periodic re-run (optional).
		if (config.command && config.commandRefreshSeconds && config.commandRefreshSeconds > 0) {
			cmdRefreshTimer = setInterval(() => {
				try {
					if (enabled && state.tui && state.footerData) {
						runner?.schedule(ctx, pi, state.footerData, state.tui);
					}
				} catch {
					// Skip this tick; never crash the host.
				}
			}, intervalDelay(config.commandRefreshSeconds));
			if (typeof cmdRefreshTimer.unref === "function") cmdRefreshTimer.unref();
		}
	}

	function stopTimers(): void {
		if (gitTimer) { clearInterval(gitTimer); gitTimer = undefined; }
		if (cmdRefreshTimer) { clearInterval(cmdRefreshTimer); cmdRefreshTimer = undefined; }
	}

	/** Request a footer re-render. */
	function requestRender(): void {
		state.tui?.requestRender();
	}

	/** Trigger a command-mode refresh (debounced inside CommandRunner). */
	function triggerCommand(ctx: ExtensionContext): void {
		if (!config.command || !enabled || !state.tui || !state.footerData) return;
		runner?.schedule(ctx, pi, state.footerData, state.tui);
	}

	function enable(ctx: ExtensionContext): void {
		enabled = true;
		reload(ctx);

		// Initial git refresh (async, non-blocking). pi installs no
		// unhandledRejection handler, so the chain must never reject.
		void refreshGitStatus(pi, ctx.cwd, state.git)
			.then((g) => {
				state.git = g;
				requestRender();
			})
			.catch(() => {});

		ctx.ui.setFooter((tui, theme, footerData) => {
			state.tui = tui;
			state.theme = theme;
			state.footerData = footerData;

			const unsub = footerData.onBranchChange(() => {
				// pi dispatches branch-change listeners unguarded (and from a
				// void'd async chain) — a throw here would take down the host.
				try {
					state.git = { ...state.git, branch: footerData.getGitBranch() };
					requestRender();
					if (config.command) triggerCommand(ctx);
				} catch {
					// Skip this update; never crash the host.
				}
			});
			state.git = { ...state.git, branch: footerData.getGitBranch() };

			return {
				dispose: () => {
					unsub();
					runner?.dispose();
					stopTimers();
				},
				invalidate() {},
				render(width: number): string[] {
					if (!config.enabled) return [];
					state.lastWidth = width;
					if (config.command && runner) return runner.getLines(width);
					// renderDefault reads ctx getters (model, context usage, session
					// entries) that throw once this footer outlives its session — the
					// TUI render loop does not guard component render(), so a throw
					// here would kill pi. Render nothing; the new session's instance
					// re-registers the footer.
					try {
						return renderDefault(ctx, pi, footerData, theme, config, state, width);
					} catch {
						return [];
					}
				},
			};
		});
	}

	function disable(ctx: ExtensionContext): void {
		enabled = false;
		stopTimers();
		runner?.dispose();
		runner = null;
		ctx.ui.setFooter(undefined);
	}

	// Lifecycle.
	pi.on("session_start", async (_event, ctx) => {
		enable(ctx);
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		stopTimers();
		runner?.dispose();
	});

	// Reactive refresh — default mode re-renders on these; command mode re-spawns.
	const refresh = async (_event: unknown, ctx: ExtensionContext) => {
		if (!enabled) return;
		// Git may have changed after a tool execution / turn.
		void refreshGitStatus(pi, ctx.cwd, state.git).then((g) => {
			state.git = g;
		});
		if (config.command) {
			triggerCommand(ctx);
		} else {
			requestRender();
		}
	};

	pi.on("turn_end", refresh);
	pi.on("tool_execution_end", refresh);
	pi.on("message_end", refresh);
	pi.on("model_select", refresh);
	pi.on("thinking_level_select", refresh);
	pi.on("session_info_changed", refresh);

	// Commands.
	pi.registerCommand("cc-status", {
		description: "Toggle the Claude-style status line on/off",
		handler: async (_args, ctx) => {
			if (enabled) {
				disable(ctx);
				ctx.ui.notify("cc-status: off", "info");
			} else {
				enable(ctx);
				ctx.ui.notify("cc-status: on", "info");
			}
		},
	});

	pi.registerCommand("cc-status:reload", {
		description: "Re-read the cc-status config file",
		handler: async (_args, ctx) => {
			reload(ctx);
			requestRender();
			if (config.command) triggerCommand(ctx);
			ctx.ui.notify(`cc-status: reloaded (mode: ${config.command ? "command" : "default"})`, "info");
		},
	});

	pi.registerCommand("cc-status:edit", {
		description: "Open the cc-status config file in the editor",
		handler: async (_args, ctx) => {
			const content = await ctx.ui.editor("cc-status config", JSON.stringify(config, null, 2));
			if (content !== undefined) {
				try {
					const path = globalConfigPath();
					mkdirSync(dirname(path), { recursive: true });
					writeFileSync(path, content, "utf8");
					reload(ctx);
					requestRender();
					if (config.command) triggerCommand(ctx);
					ctx.ui.notify(`cc-status: saved ${path}`, "info");
				} catch (e) {
					ctx.ui.notify(`cc-status: save failed — ${e}`, "error");
				}
			}
		},
	});
}
