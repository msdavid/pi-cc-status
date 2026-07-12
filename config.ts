/**
 * Configuration for pi-cc-status.
 *
 * Pi exposes no settings-reading API to extensions, so this package manages its
 * own config file. Resolution: defaults ← global ← project (field-by-field).
 *
 *   global:  ~/.pi/agent/cc-status/config.json
 *   project: .pi/cc-status/config.json   (relative to the session cwd)
 *
 * Both files are optional. A missing file is treated as an empty override.
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Bar gauge appearance. */
export interface BarConfig {
	/** Number of cells. */
	width: number;
	/** Filled-cell character. */
	filled: string;
	/** Empty-cell character. */
	empty: string;
}

/** Accessibility presentation overrides (WCAG-leaning). */
export interface AccessibilityConfig {
	/** Enable accessibility presentation. */
	enabled: boolean;
	/** Prefix segments with semantic labels (Model:, Dir:, …). */
	labels: boolean;
	/** Use plain ASCII for the bar (= / -) instead of Unicode block glyphs. */
	plainBar: boolean;
}

/** Full config. */
export interface Config {
	/** Master on/off. */
	enabled: boolean;
	/** Ordered segment ids rendered left-to-right by the default renderer. */
	segments: SegmentId[];
	/** Separator between segments. */
	separator: string;
	/** Bar gauge appearance. */
	bar: BarConfig;
	/** Context-window percentage thresholds for color escalation. */
	thresholds: { warning: number; error: number };
	/** Background git-status poll interval, seconds. 0 disables the timer. */
	refreshSeconds: number;
	/** Show cache-read % alongside the context bar. */
	showCachePercent: boolean;
	/** Accessibility presentation overrides. */
	accessibility: AccessibilityConfig;
	/**
	 * Shell command for command mode (Claude-Code-style: receives JSON on stdin,
	 * stdout is displayed). When set, the default renderer is bypassed.
	 */
	command: string | null;
	/** Periodic re-run interval for command mode, seconds. null = event-only. */
	commandRefreshSeconds: number | null;
}

/** Segment ids available to the default renderer. */
export type SegmentId =
	| "model"
	| "dir"
	| "effort"
	| "context"
	| "git"
	| "session"
	| "cost"
	| "tokens"
	| "version"
	| "providers";

export const DEFAULT_SEGMENTS: SegmentId[] = ["model", "dir", "effort", "context", "git"];

export function defaultConfig(): Config {
	return {
		enabled: true,
		segments: [...DEFAULT_SEGMENTS],
		separator: " | ",
		bar: { width: 10, filled: "█", empty: "░" },
		thresholds: { warning: 80, error: 95 },
		refreshSeconds: 2,
		showCachePercent: true,
		accessibility: { enabled: false, labels: true, plainBar: true },
		command: null,
		commandRefreshSeconds: null,
	};
}

/** Global config path: ~/.pi/agent/cc-status/config.json */
export function globalConfigPath(): string {
	return join(homedir(), ".pi", "agent", "cc-status", "config.json");
}

/** Project config path: <cwd>/.pi/cc-status/config.json */
export function projectConfigPath(cwd: string): string {
	return join(cwd, ".pi", "cc-status", "config.json");
}

function readJson(path: string): Record<string, unknown> | null {
	try {
		if (!existsSync(path)) return null;
		const raw = readFileSync(path, "utf8");
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/** Merge an override object onto a Config, deep-merging nested bar/thresholds/accessibility. */
export function mergeConfig(base: Config, override: Record<string, unknown>): Config {
	const out: Config = { ...base };
	const sink = out as unknown as Record<string, unknown>;
	for (const [k, v] of Object.entries(override)) {
		if (v === undefined) continue;
		switch (k) {
			case "bar":
				if (isObject(v)) out.bar = { ...base.bar, ...(v as Partial<BarConfig>) };
				break;
			case "thresholds":
				if (isObject(v)) out.thresholds = { ...base.thresholds, ...(v as { warning?: number; error?: number }) };
				break;
			case "accessibility":
				if (isObject(v)) out.accessibility = { ...base.accessibility, ...(v as Partial<AccessibilityConfig>) };
				break;
			case "segments":
				if (Array.isArray(v)) out.segments = v.filter((s): s is SegmentId => typeof s === "string") as SegmentId[];
				break;
			default:
				if (k in out) sink[k] = v;
		}
	}
	return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Load merged config: defaults ← global ← project. Never throws. */
export function loadConfig(cwd: string): Config {
	let cfg = defaultConfig();
	const g = readJson(globalConfigPath());
	if (g) cfg = mergeConfig(cfg, g);
	const p = readJson(projectConfigPath(cwd));
	if (p) cfg = mergeConfig(cfg, p);
	return cfg;
}
