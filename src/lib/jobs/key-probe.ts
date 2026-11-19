import { decryptApiKey } from "@/lib/crypto";
import {
	countSuspensionStreak,
	isProviderFailureEpisode,
	maybeDisableKeyAfterAuthFailures,
	updateKeyHealth,
} from "@/lib/key-store";
import { getProviderConfig } from "@/lib/provider-catalog";
import type { D1Database, HealthStatus } from "@/lib/types";
import {
	type FetchImpl,
	fetchUpstreamModelList,
	probeAnthropicChat,
} from "./upstream";

export interface KeyProbeSummary {
	/** Enabled keys examined this run. */
	checked: number;
	healthy: number;
	invalid: number;
	errored: number;
	/** Keys newly suspended this run. */
	suspended: number;
	/** Keys whose expired suspension was cleared after a good probe. */
	reenabled: number;
	/** Keys not probed: still suspended, unreadable, or unprobable. */
	skipped: number;
}

export interface KeyProbeOptions {
	/** Epoch ms used for suspension deadlines; defaults to `Date.now()`. */
	now?: number;
	/** Max keys probed per run; defaults to 50, stalest first. */
	batchSize?: number;
	/** Required: pool keys cannot be decrypted without it. */
	encryptionSecret: string;
	/** Consecutive failures after which a key is suspended; defaults to 5. */
	consecutiveFailuresToSuspend?: number;
	/** Suspension length; defaults to 24 h. */
	suspensionMs?: number;
	fetchImpl?: FetchImpl;
}

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_CONSECUTIVE_FAILURES_TO_SUSPEND = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Sentinel model id for probe attempts in `provider_requests`. Probes
 * are not chat traffic: the sentinel keeps them out of per-model
 * scoring (`scoreChain`) and out of the Q5 success join, while the
 * rows still feed the consecutive-failure counts and the Fix C
 * auth-failure check, which both read by `key_id` only.
 */
export const PROBE_MODEL_ID = "__probe__";

interface KeyRow {
	id: number;
	user_id: string;
	platform: string;
	encrypted_key: string;
	iv: string;
	auth_tag: string;
	suspended_until_ms?: number | null;
	suspension_reason?: string | null;
	last_health_check_at: string | null;
}

/**
 * The suspension columns land in migration 0019 (another agent).
 * Until they exist the probe still checks health, but never suspends
 * or re-enables — a missing column must not fail the whole run.
 */
async function suspensionColumnsExist(db: D1Database): Promise<boolean> {
	try {
		await db
			.prepare(
				"SELECT suspended_until_ms, suspension_reason FROM api_keys LIMIT 0",
			)
			.all();
		return true;
	} catch {
		return false;
	}
}

async function suspendKey(
	db: D1Database,
	keyId: number,
	untilMs: number,
	reason: string,
): Promise<void> {
	await db
		.prepare(
			`UPDATE api_keys SET suspended_until_ms = ?, suspension_reason = ?,
			 updated_at = datetime('now') WHERE id = ?`,
		)
		.bind(untilMs, reason, keyId)
		.run();
}

async function clearSuspension(db: D1Database, keyId: number): Promise<void> {
	await db
		.prepare(
			`UPDATE api_keys SET suspended_until_ms = NULL, suspension_reason = NULL,
			 updated_at = datetime('now') WHERE id = ?`,
		)
		.bind(keyId)
		.run();
}

async function recordProbeAttempt(
	db: D1Database,
	row: KeyRow,
	status: "success" | "error",
	statusCode: number,
	latencyMs: number,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO provider_requests
			 (user_id, model_requested, model_routed, platform, key_id,
			  status, status_code, error_message, latency_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.user_id,
			PROBE_MODEL_ID,
			PROBE_MODEL_ID,
			row.platform,
			row.id,
			status,
			statusCode,
			status === "success" ? null : `probe_http_${statusCode}`,
			latencyMs,
		)
		.run();
}

/**
 * Key probe job (audit §E 2.4 / R7): a cheap upstream call per enabled
 * key, outside the request path, that turns `last_health_check_*`
 * into real health. Probe per platform (documented choice):
 *
 * - `openai_compatible` / `cohere_compat` / `cloudflare_openai` /
 *   `ai_horde`: `GET {baseUrl}/models` (Bearer; Cloudflare splits
 *   `accountId:token` and lists via `/accounts/{id}/ai/v1/models/search`).
 * - `google_gemini`: `GET {baseUrl}/models?key=...`.
 * - `anthropic_messages`: no list endpoint, so a minimal chat —
 *   `POST /messages` with `max_tokens: 1` on the platform's first
 *   enabled model.
 *
 * Attribution: only an HTTP answer is recorded in
 * `provider_requests`. A 404 means the probe endpoint or the probe
 * model does not exist — a catalog problem, not a dead key — and a
 * network error never reached the upstream, so neither is recorded
 * and neither counts toward suspension. 401/403 is `invalid` and
 * goes through the existing Fix C expurgo
 * (`maybeDisableKeyAfterAuthFailures`); any other recorded failure
 * counts toward the N-consecutive suspension below, under the same
 * shared streak rule as the request path (`countSuspensionStreak`):
 * 429/400/410, model_mismatch and empty 200s never count, and a
 * platform-wide failure episode suspends nothing.
 */
export async function runKeyProbe(
	db: D1Database,
	options: KeyProbeOptions,
): Promise<KeyProbeSummary> {
	const now = options.now ?? Date.now();
	const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
	const failuresToSuspend =
		options.consecutiveFailuresToSuspend ??
		DEFAULT_CONSECUTIVE_FAILURES_TO_SUSPEND;
	const suspensionMs = options.suspensionMs ?? DAY_MS;
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const summary: KeyProbeSummary = {
		checked: 0,
		healthy: 0,
		invalid: 0,
		errored: 0,
		suspended: 0,
		reenabled: 0,
		skipped: 0,
	};
	const suspensionAvailable = await suspensionColumnsExist(db);
	if (!suspensionAvailable) {
		console.error(
			JSON.stringify({
				event: "key_probe",
				reason: "suspension_columns_missing",
			}),
		);
	}

	// The batch SELECT only references the suspension columns when
	// they exist: without migration 0019 the query itself would fail.
	const suspensionColumns = suspensionAvailable
		? "suspended_until_ms, suspension_reason,"
		: "";
	const keys = await db
		.prepare(
			`SELECT id, user_id, platform, encrypted_key, iv, auth_tag,
			        ${suspensionColumns} last_health_check_at
			  FROM api_keys WHERE enabled = 1
			  ORDER BY (last_health_check_at IS NOT NULL), last_health_check_at ASC, id ASC
			  LIMIT ?`,
		)
		.bind(batchSize)
		.all<KeyRow>();
	summary.checked = keys.results.length;

	for (const row of keys.results) {
		const suspendedUntilMs = row.suspended_until_ms ?? null;
		if (
			suspensionAvailable &&
			suspendedUntilMs !== null &&
			suspendedUntilMs > now
		) {
			// Still suspended: probing would only burn an upstream call.
			summary.skipped++;
			continue;
		}
		const hadExpiredSuspension =
			suspensionAvailable && suspendedUntilMs !== null;

		const provider = await getProviderConfig(row.platform, db);
		if (!provider) {
			summary.skipped++;
			continue;
		}
		let apiKey: string;
		try {
			apiKey = await decryptApiKey(
				{
					ciphertext: row.encrypted_key,
					iv: row.iv,
					authTag: row.auth_tag,
				},
				options.encryptionSecret,
			);
		} catch {
			console.error(
				JSON.stringify({
					event: "key_decrypt_failed",
					keyId: row.id,
					platform: row.platform,
				}),
			);
			await updateKeyHealth(db, row.id, "error");
			summary.errored++;
			continue;
		}

		const startedAt = Date.now();
		let status: number | null;
		let malformedKey = false;
		if (provider.protocol === "anthropic_messages") {
			const model = await db
				.prepare(
					`SELECT model_id FROM models WHERE platform = ? AND enabled = 1
					  ORDER BY model_id ASC LIMIT 1`,
				)
				.bind(row.platform)
				.first<{ model_id: string }>();
			if (!model) {
				summary.skipped++;
				continue;
			}
			status = (
				await probeAnthropicChat(provider, apiKey, model.model_id, fetchImpl)
			).status;
		} else {
			const list = await fetchUpstreamModelList(provider, apiKey, fetchImpl);
			status = list.status;
			malformedKey = list.malformedKey === true;
		}
		const latencyMs = Date.now() - startedAt;

		if (malformedKey) {
			await updateKeyHealth(db, row.id, "invalid");
			summary.invalid++;
			continue;
		}
		if (status === null || status === 404) {
			// Never reached the upstream, or the probe endpoint/model
			// does not exist: not attributable to the key, not recorded.
			await updateKeyHealth(db, row.id, "error");
			summary.errored++;
			continue;
		}

		const outcome: "success" | "error" =
			status >= 200 && status < 300 ? "success" : "error";
		await recordProbeAttempt(db, row, outcome, status, latencyMs);
		if (outcome === "success") {
			await updateKeyHealth(db, row.id, "healthy");
			summary.healthy++;
			if (hadExpiredSuspension) {
				await clearSuspension(db, row.id);
				summary.reenabled++;
				console.error(
					JSON.stringify({
						event: "key_reenabled",
						keyId: row.id,
						platform: row.platform,
					}),
				);
			}
			continue;
		}

		const health: HealthStatus =
			status === 401 || status === 403 ? "invalid" : "error";
		await updateKeyHealth(db, row.id, health);
		if (health === "invalid") summary.invalid++;
		else summary.errored++;

		let disabled = false;
		if (status === 401 || status === 403) {
			disabled = await maybeDisableKeyAfterAuthFailures(
				db,
				row.platform,
				row.id,
			);
		}
		if (!disabled && suspensionAvailable) {
			const { failures } = await countSuspensionStreak(db, row.id);
			if (failures >= failuresToSuspend) {
				if (await isProviderFailureEpisode(db, row.platform, now)) {
					// Every enabled key of the platform failed recently:
					// a platform episode, not a dead key.
					console.error(
						JSON.stringify({
							event: "provider_failure_episode",
							platform: row.platform,
							keyId: row.id,
						}),
					);
				} else {
					await suspendKey(
						db,
						row.id,
						now + suspensionMs,
						"consecutive_failures",
					);
					summary.suspended++;
					console.error(
						JSON.stringify({
							event: "key_suspended",
							keyId: row.id,
							platform: row.platform,
							consecutiveFailures: failures,
						}),
					);
				}
			}
		}
	}

	console.error(JSON.stringify({ event: "key_probe", ...summary }));
	return summary;
}
