import type { D1Database } from "./types";

/**
 * Keys skipped without an upstream attempt while routing one request:
 * the model row had no enabled key at all, the key was in quarantine,
 * the gateway rate limiter held the key back, or the key was
 * suspended (Fase 2.4). Counted per key (a model row with no keys
 * counts once), so a 502 with attempts 0 stops being indistinguishable
 * from "upstream down".
 */
export interface RouteSkipped {
	noKey: number;
	quarantined: number;
	rateLimited: number;
	suspended: number;
}

/** One failed upstream attempt, as the router logs it. */
export interface RouteExhaustedAttempt {
	platform: string;
	modelId: string;
	keyId: number;
	status: number;
	kind: string;
	latencyMs: number;
	phase: "member" | "fallback";
	retryAfterMs?: number;
}

/**
 * Log the exhaustion and persist the aggregate in D1 (migration 0018).
 * The insert is best-effort: observability must never fail the client
 * response, so a broken insert is logged and swallowed.
 */
export async function logRouteExhausted(
	db: D1Database,
	input: {
		model: string;
		attempts: number;
		skipped: RouteSkipped;
		attemptLog: readonly RouteExhaustedAttempt[];
		status: number;
	},
): Promise<void> {
	const kinds: string[] = [];
	for (const attempt of input.attemptLog) {
		if (!kinds.includes(attempt.kind)) kinds.push(attempt.kind);
	}
	console.error(
		JSON.stringify({
			event: "route_exhausted",
			model: input.model,
			attempts: input.attempts,
			status: input.status,
			skipped: input.skipped,
			kinds,
			attemptLog: input.attemptLog,
		}),
	);
	try {
		await db
			.prepare(
				`INSERT INTO route_exhausted_events
				 (created_at_ms, model, attempts, skipped_json, kinds_json, attempt_log_json)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				Date.now(),
				input.model,
				input.attempts,
				JSON.stringify(input.skipped),
				JSON.stringify(kinds),
				JSON.stringify(input.attemptLog),
			)
			.run();
	} catch (err) {
		console.error(
			JSON.stringify({
				event: "route_exhausted_persist_failed",
				model: input.model,
				error: err instanceof Error ? err.message : "unknown",
			}),
		);
	}
}
