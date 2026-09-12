/**
 * Tests for index.ts — after_provider_response must never stall the turn.
 *
 * pi awaits after_provider_response handlers before finalizing a response, so
 * the endpoint lookup (getProviderAuth + the 404 retry loop, ~25s worst case)
 * must run detached. These tests pin that contract.
 *
 * Run: node --test test/
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ccStatus from "../index.ts";

interface Recording {
	handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
	setFooterFactory: ((...args: unknown[]) => unknown) | null;
}

/** Minimal fake ExtensionAPI + ExtensionContext good enough for enable(). */
function makeHarness(opts: { auth?: () => Promise<unknown>; noSetFooter?: boolean } = {}): { pi: Record<string, unknown>; ctx: Record<string, unknown>; rec: Recording } {
	const rec: Recording = { handlers: new Map(), setFooterFactory: null };
	const pi = {
		on: (type: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			rec.handlers.set(type, handler);
		},
		registerCommand: (_name: string, _cmd: unknown) => {},
		exec: async () => ({ code: 1, stdout: "" }), // not a git repo
		getSessionName: () => null,
		getThinkingLevel: () => "off",
	};
	const ctx = {
		cwd: mkdtempSync(join(tmpdir(), "cc-status-test-")), // no project config here
		model: { provider: "openrouter" },
		modelRegistry: { getProviderAuth: opts.auth ?? (async () => ({ auth: { apiKey: "k" } })) },
		ui: opts.noSetFooter ? {} : {
			setFooter: (factory: (...args: unknown[]) => unknown) => {
				rec.setFooterFactory = factory;
			},
		},
	};
	return { pi, ctx, rec };
}

test("enable(): tolerates hosts without ctx.ui.setFooter (pi-web-ui subagent contexts)", async () => {
	// pi-web-ui binds subagent conversations to a minimal uiContext with no
	// setFooter — session_start must not throw and must register nothing.
	const { pi, ctx, rec } = makeHarness({ noSetFooter: true });
	(ccStatus as (p: unknown) => void)(pi);
	await rec.handlers.get("session_start")!({}, ctx);
	assert.equal(rec.setFooterFactory, null);

	// The refresh handlers stay live but must no-op safely without a footer.
	await rec.handlers.get("turn_end")!({}, ctx);
	await new Promise((r) => setTimeout(r, 25)); // git refresh chain settles
});

/** Minimal stubs for the footer factory's (tui, theme, footerData) arguments. */
function footerStubs() {
	return {
		tui: { requestRender() {} },
		theme: {},
		footerData: { onBranchChange: () => () => {}, getGitBranch: () => null },
	};
}

test("after_provider_response: skips the lookup entirely without a TUI (pi -p)", async () => {
	let authCalls = 0;
	const { pi, ctx, rec } = makeHarness({
		auth: async () => {
			authCalls++;
			return { auth: { apiKey: "k" } };
		},
	});
	(ccStatus as (p: unknown) => void)(pi);
	await rec.handlers.get("session_start")!({}, ctx);
	assert.equal(rec.setFooterFactory === null, false);

	const handler = rec.handlers.get("after_provider_response")!;
	await handler({ headers: { "x-generation-id": "gen-1" } }, ctx);
	// The handler must have returned without ever reaching getProviderAuth.
	await new Promise((r) => setTimeout(r, 25));
	assert.equal(authCalls, 0);
});

test("after_provider_response: returns without awaiting the lookup (detached)", async () => {
	let resolveAuth!: (v: unknown) => void;
	const authPromise = new Promise((r) => {
		resolveAuth = r;
	});
	const { pi, ctx, rec } = makeHarness({ auth: () => authPromise });
	(ccStatus as (p: unknown) => void)(pi);
	await rec.handlers.get("session_start")!({}, ctx);

	// Simulate the TUI having rendered the footer once.
	rec.setFooterFactory!(footerStubs().tui, footerStubs().theme, footerStubs().footerData);

	const handler = rec.handlers.get("after_provider_response")! as (e: unknown, c: unknown) => Promise<void>;
	const ret = handler({ headers: { "x-generation-id": "gen-1" } }, ctx);
	// The fixed handler is synchronous — it must not return a promise chained
	// onto the lookup, and auth is still pending while it returns.
	assert.equal(ret, undefined, "handler must return synchronously, not await the lookup");
	await new Promise((r) => setTimeout(r, 50)); // no unhandled rejection while auth pends
	resolveAuth({ auth: { apiKey: "k" } });
	await new Promise((r) => setTimeout(r, 50)); // detached chain settles cleanly
});

test("after_provider_response: detached lookup lands and updates state (no crash)", async () => {
	let renderCalls = 0;
	const { pi, ctx, rec } = makeHarness({ auth: async () => ({ auth: { apiKey: "k" } }) });
	(ccStatus as (p: unknown) => void)(pi);
	await rec.handlers.get("session_start")!({}, ctx);
	const stubs = footerStubs();
	stubs.tui.requestRender = () => {
		renderCalls++;
	};
	rec.setFooterFactory!(stubs.tui, stubs.theme, stubs.footerData);

	// enable()'s initial git refresh fires one legitimate requestRender; let it
	// land and take a baseline so we only assert about the lookup itself.
	await new Promise((r) => setTimeout(r, 25));
	const baseline = renderCalls;

	// The real fetchEndpointName runs here; with no reachable generation id it
	// must resolve null (never reject) and the chain must not throw.
	const handler = rec.handlers.get("after_provider_response")! as (e: unknown, c: unknown) => Promise<void>;
	await handler({ headers: { "x-generation-id": "gen-nope" } }, ctx);
	await new Promise((r) => setTimeout(r, 25));
	assert.equal(renderCalls, baseline); // lookup failed fast → no extra render
});
