/**
 * Tests for pi-cc-status endpoint.ts — OpenRouter active-endpoint resolution.
 *
 * Run: node --test test/
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractGenerationId, fetchEndpointName } from "../endpoint.ts";

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status });
}

test("extractGenerationId: lowercase header", () => {
	assert.equal(extractGenerationId({ "x-generation-id": "gen-abc" }), "gen-abc");
});

test("extractGenerationId: mixed-case header", () => {
	assert.equal(extractGenerationId({ "X-Generation-Id": "gen-abc" }), "gen-abc");
});

test("extractGenerationId: trims whitespace, skips empty", () => {
	assert.equal(extractGenerationId({ "x-generation-id": "  gen-abc  " }), "gen-abc");
	assert.equal(extractGenerationId({ "x-generation-id": "   " }), null);
});

test("extractGenerationId: absent / malformed headers → null", () => {
	assert.equal(extractGenerationId({}), null);
	assert.equal(extractGenerationId({ "retry-after": "30" }), null);
	assert.equal(extractGenerationId(undefined as unknown as Record<string, unknown>), null);
	assert.equal(extractGenerationId({ "x-generation-id": 42 as unknown as string }), null);
});

const KEY = "sk-or-test";
const OK_BODY = { data: { id: "gen-abc", provider_name: "Modal" } };

test("fetchEndpointName: immediate success", async () => {
	const calls: string[] = [];
	const name = await fetchEndpointName("gen-abc", KEY, {
		fetchImpl: async (url, init) => {
			calls.push(String(url));
			assert.match(String(init?.headers?.Authorization), /^Bearer sk-or-test$/);
			return jsonResponse(200, OK_BODY);
		},
		delays: [0],
	});
	assert.equal(name, "Modal");
	assert.equal(calls.length, 1);
	assert.equal(calls[0], "https://openrouter.ai/api/v1/generation?id=gen-abc");
});

test("fetchEndpointName: 404 then success (metadata lag)", async () => {
	let n = 0;
	const name = await fetchEndpointName("gen-abc", KEY, {
		fetchImpl: async () => {
			n++;
			return n < 3 ? jsonResponse(404, { error: "not found" }) : jsonResponse(200, OK_BODY);
		},
		delays: [0, 0, 0],
	});
	assert.equal(name, "Modal");
	assert.equal(n, 3);
});

test("fetchEndpointName: exhausted 404 retries → null", async () => {
	let n = 0;
	const name = await fetchEndpointName("gen-abc", KEY, {
		fetchImpl: async () => {
			n++;
			return jsonResponse(404, {});
		},
		delays: [0, 0, 0],
	});
	assert.equal(name, null);
	assert.equal(n, 3);
});

test("fetchEndpointName: non-404 error fails fast", async () => {
	let n = 0;
	const name = await fetchEndpointName("gen-abc", KEY, {
		fetchImpl: async () => {
			n++;
			return jsonResponse(401, { error: "nope" });
		},
		delays: [0, 0, 0],
	});
	assert.equal(name, null);
	assert.equal(n, 1);
});

test("fetchEndpointName: malformed body / missing provider_name → null", async () => {
	const name = await fetchEndpointName("gen-abc", KEY, {
		fetchImpl: async () => jsonResponse(200, { data: {} }),
		delays: [0],
	});
	assert.equal(name, null);
});

test("fetchEndpointName: network failure → null (never rejects)", async () => {
	const name = await fetchEndpointName("gen-abc", KEY, {
		fetchImpl: async () => {
			throw new Error("boom");
		},
		delays: [0, 0, 0],
	});
	assert.equal(name, null);
});

test("fetchEndpointName: URL-encodes the generation id", async () => {
	let seen = "";
	await fetchEndpointName("gen/abc+def", KEY, {
		fetchImpl: async (url) => {
			seen = String(url);
			return jsonResponse(200, OK_BODY);
		},
		delays: [0],
	});
	assert.equal(seen, "https://openrouter.ai/api/v1/generation?id=gen%2Fabc%2Bdef");
});
