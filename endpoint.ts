/**
 * Active-endpoint resolution for OpenRouter models.
 *
 * OpenRouter routes each request to an upstream inference provider (Modal,
 * Novita, …). pi only ever sees "openrouter", so the status line cannot know
 * which endpoint served a response — OpenRouter does, via its generation
 * metadata API:
 *
 *   1. Every OpenRouter response carries an `x-generation-id` header.
 *   2. GET /api/v1/generation?id=<id> returns `data.provider_name`, the
 *      upstream provider that actually served the request.
 *
 * Generation metadata is written asynchronously by OpenRouter and may not be
 * readable for a few seconds, so the fetch retries on 404 before giving up.
 */

const GENERATION_URL = "https://openrouter.ai/api/v1/generation";

/** Default retry delays (ms) between generation-metadata attempts (~25s window). */
export const ENDPOINT_RETRY_DELAYS_MS = [0, 2000, 4000, 6000, 8000, 10000];

/**
 * Extract the OpenRouter generation id from normalized response headers.
 * Header lookup is case-insensitive; returns null when absent.
 */
export function extractGenerationId(headers: Record<string, unknown>): string | null {
	if (!headers || typeof headers !== "object") return null;
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== "x-generation-id") continue;
		if (typeof value === "string" && value.trim() !== "") return value.trim();
	}
	return null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true },
		);
	});
}

export interface FetchEndpointOptions {
	/** Injectable fetch for tests. Defaults to globalThis.fetch. */
	fetchImpl?: typeof fetch;
	/** Retry delays (ms); attempt i sleeps delays[i] before firing. */
	delays?: number[];
	/** Optional abort signal for the whole lookup. */
	signal?: AbortSignal;
}

/**
 * Resolve the upstream provider name for a generation id.
 *
 * Retries while metadata is not yet readable — 404 (OpenRouter writes
 * generation records asynchronously) and transient network failures — using
 * `delays`. Other failures (auth, malformed body, exhausted retries) resolve
 * null. Never rejects; callers treat null as "unknown this round".
 */
export async function fetchEndpointName(genId: string, apiKey: string, options: FetchEndpointOptions = {}): Promise<string | null> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const delays = options.delays ?? ENDPOINT_RETRY_DELAYS_MS;
	const signal = options.signal;
	let lastError: unknown = null;
	for (let attempt = 0; attempt < delays.length; attempt++) {
		try {
			await sleep(delays[attempt] ?? 0, signal);
			if (signal?.aborted) return null;
			const res = await fetchImpl(`${GENERATION_URL}?id=${encodeURIComponent(genId)}`, {
				headers: { Authorization: `Bearer ${apiKey}` },
				signal,
			});
			if (res.status === 404) continue; // metadata not written yet
			if (!res.ok) return null;
			const body = (await res.json()) as { data?: { provider_name?: unknown } };
			const name = body?.data?.provider_name;
			return typeof name === "string" && name.trim() !== "" ? name.trim() : null;
		} catch (error) {
			lastError = error;
			if (signal?.aborted) return null;
			continue; // transient network failure — retry within the window
		}
	}
	void lastError;
	return null;
}
