/**
 * Tests for pi-cc-status data.ts cost accounting.
 *
 * Run: node --test test/
 * Node >= 22.6 (native TS type stripping).
 *
 * The pi host packages resolve through the node_modules symlinks documented
 * in README (development section).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { usageCostTotal, computeSessionFileCost, getChildSessionsCost } from "../data.ts";

function tmpDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-cc-status-test-"));
}

function writeSession(path: string, header: Record<string, unknown>, entries: unknown[]): void {
	const lines = [JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/x", ...header })];
	for (const e of entries) lines.push(JSON.stringify(e));
	writeFileSync(path, lines.join("\n") + "\n", "utf8");
}

function msg(role: string, cost: number | null, extra: Record<string, unknown> = {}) {
	return {
		type: "message",
		id: Math.random().toString(36).slice(2),
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role,
			...(cost !== null ? { usage: { input: 10, output: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } } } : {}),
			...extra,
		},
	};
}

test("usageCostTotal: object with total", () => {
	assert.equal(usageCostTotal({ cost: { total: 1.5 } }), 1.5);
});

test("usageCostTotal: bare number cost", () => {
	assert.equal(usageCostTotal({ cost: 2 }), 2);
});

test("usageCostTotal: negative, NaN, missing, non-object → 0", () => {
	assert.equal(usageCostTotal({ cost: -1 }), 0);
	assert.equal(usageCostTotal({ cost: Number.NaN }), 0);
	assert.equal(usageCostTotal({ cost: { total: Number.POSITIVE_INFINITY } }), 0);
	assert.equal(usageCostTotal({}), 0);
	assert.equal(usageCostTotal(null), 0);
	assert.equal(usageCostTotal("nope"), 0);
});

test("computeSessionFileCost: assistant + toolResult + compaction + branch_summary", () => {
	const dir = tmpDir();
	try {
		const f = join(dir, "s.jsonl");
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "t", cwd: "/x" }),
			JSON.stringify(msg("assistant", 0.1)),
			JSON.stringify(msg("toolResult", 0.05, { toolName: "workflow" })),
			JSON.stringify({ type: "compaction", id: "c", parentId: null, timestamp: "t", summary: "s", usage: { cost: { total: 0.02 } } }),
			JSON.stringify({ type: "branch_summary", id: "b", parentId: null, timestamp: "t", fromId: "c", summary: "s", usage: { cost: { total: 0.03 } } }),
			JSON.stringify(msg("user", 0.99)), // user messages carry no usage → ignored
			JSON.stringify(msg("assistant", 0.05)),
			"not json at all",
			"",
		];
		writeFileSync(f, lines.join("\n") + "\n", "utf8");
		assert.ok(Math.abs(computeSessionFileCost(f) - 0.25) < 1e-9);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("computeSessionFileCost: missing file → 0", () => {
	assert.equal(computeSessionFileCost(join(tmpdir(), "does-not-exist.jsonl")), 0);
});

test("getChildSessionsCost: direct + transitive links, excludes unrelated and broken", () => {
	const dir = tmpDir();
	try {
		const parent = join(dir, "parent.jsonl");
		const childA = join(dir, "childA.jsonl");
		const childB = join(dir, "childB.jsonl");
		const unrelated = join(dir, "unrelated.jsonl");
		writeSession(parent, {}, [msg("assistant", 0.5)]);
		writeSession(childA, { parentSession: parent }, [msg("assistant", 0.1), msg("toolResult", 0.02)]);
		writeSession(childB, { parentSession: childA }, [msg("assistant", 0.05)]);
		writeSession(unrelated, { parentSession: "/somewhere/else.jsonl" }, [msg("assistant", 9.99)]);
		writeFileSync(join(dir, "broken.jsonl"), "garbage\n", "utf8");
		writeFileSync(join(dir, "notes.txt"), "ignored\n", "utf8");

		// Child total only — the parent's own cost is accounted from the live
		// branch via ctx, not from the file scan.
		assert.ok(Math.abs(getChildSessionsCost(parent) - 0.17) < 1e-9);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("getChildSessionsCost: no children → 0", () => {
	const dir = tmpDir();
	try {
		const parent = join(dir, "parent.jsonl");
		writeSession(parent, {}, [msg("assistant", 0.5)]);
		assert.equal(getChildSessionsCost(parent), 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("getChildSessionsCost: null/undefined parent → 0", () => {
	assert.equal(getChildSessionsCost(null), 0);
	assert.equal(getChildSessionsCost(undefined), 0);
});

test("getChildSessionsCost: cache picks up appended usage after TTL", async () => {
	const dir = tmpDir();
	try {
		const parent = join(dir, "parent.jsonl");
		const child = join(dir, "child.jsonl");
		writeSession(parent, {}, []);
		writeSession(child, { parentSession: parent }, [msg("assistant", 0.1)]);
		assert.ok(Math.abs(getChildSessionsCost(parent) - 0.1) < 1e-9);

		// Within the TTL the cached value is returned even if the file changes.
		writeSession(child, { parentSession: parent }, [msg("assistant", 0.1), msg("assistant", 0.2)]);
		assert.ok(Math.abs(getChildSessionsCost(parent) - 0.1) < 1e-9);

		// After the TTL the rescan sees the new cost. Also bump mtime explicitly
		// so fast filesystems that keep mtime granularity can't false-pass.
		await new Promise((r) => setTimeout(r, 2100));
		const now = new Date();
		utimesSync(child, now, now);
		assert.ok(Math.abs(getChildSessionsCost(parent) - 0.3) < 1e-9);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("getChildSessionsCost: cycles in parent links terminate", () => {
	const dir = tmpDir();
	try {
		const a = join(dir, "a.jsonl");
		const b = join(dir, "b.jsonl");
		writeSession(a, { parentSession: b }, [msg("assistant", 0.1)]);
		writeSession(b, { parentSession: a }, [msg("assistant", 0.2)]);
		// Neither is reachable from a "parent" without links of its own; the
		// important part is that the walk terminates. Point a synthetic parent
		// at a and ensure no infinite loop / no double count.
		const parent = join(dir, "parent.jsonl");
		writeSession(parent, {}, []);
		writeFileSync(join(dir, "c.jsonl"), JSON.stringify({ type: "session", parentSession: parent }) + "\n" + JSON.stringify(msg("assistant", 0.3)) + "\n", "utf8");
		assert.ok(Math.abs(getChildSessionsCost(parent) - 0.3) < 1e-9);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("getChildSessionsCost: unreadable directory → 0 without throwing", () => {
	const missing = join(tmpdir(), `pi-cc-status-missing-${process.pid}`, "parent.jsonl");
	assert.equal(getChildSessionsCost(missing), 0);
});

test("getChildSessionsCost: child with zero usage contributes 0", () => {
	const dir = tmpDir();
	try {
		const parent = join(dir, "parent.jsonl");
		writeSession(parent, {}, []);
		writeSession(join(dir, "child.jsonl"), { parentSession: parent }, [msg("assistant", null)]);
		assert.equal(getChildSessionsCost(parent), 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
