import { getEnabledKeysForPlatform } from "@/lib/key-store";
import { getProviderConfig } from "@/lib/provider-catalog";
import type { D1Database } from "@/lib/types";
import { type FetchImpl, fetchUpstreamModelList } from "./upstream";

export interface CatalogValidationSummary {
	/** Enabled model rows examined. */
	checked: number;
	/** Rows newly marked suspect this run. */
	suspected: number;
	/**
	 * Distinct rows left unvalidated by this run: no success in 7
	 * days, never marked (cap hit) and never confirmed present in an
	 * upstream list. Platform skips are reported in the log only —
	 * their rows were either validated by a recent success, marked
	 * by part (a), or are already counted here.
	 */
	skipped: number;
}

export interface CatalogValidationOptions {
	/** Epoch ms used for `suspect_since`; defaults to `Date.now()`. */
	now?: number;
	/** Max rows marked suspect per run; defaults to 50. */
	maxMarked?: number;
	/**
	 * Decryption secret for pool keys. Without it the upstream
	 * comparison is skipped (part (a) still runs).
	 */
	encryptionSecret?: string;
	fetchImpl?: FetchImpl;
}

const DEFAULT_MAX_MARKED = 50;

export const SUSPECT_NO_SUCCESS_7D = "no_success_7d";
export const SUSPECT_UPSTREAM_MISSING = "upstream_missing";

/**
 * The suspect columns land in migration 0019 (another agent). Until
 * they exist the job still runs part (a)'s counting but marks nothing,
 * instead of failing the whole run on a missing column.
 */
async function suspectColumnsExist(db: D1Database): Promise<boolean> {
	try {
		await db
			.prepare("SELECT suspect_reason, suspect_since FROM models LIMIT 0")
			.all();
		return true;
	} catch {
		return false;
	}
}

/**
 * Mark one row suspect, once: rows already suspect keep their original
 * reason and timestamp, so a re-run is a no-op for them.
 */
async function markSuspect(
	db: D1Database,
	platform: string,
	modelId: string,
	reason: string,
	now: number,
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE models SET suspect_reason = ?, suspect_since = ?
			  WHERE platform = ? AND model_id = ? AND suspect_reason IS NULL`,
		)
		.bind(reason, now, platform, modelId)
		.run();
	return (result.meta?.changes ?? 0) > 0;
}

/**
 * Catalog validation job (audit §E 2.2 / R10). Two passes, never
 * deleting a row — only flagging it suspect for human review:
 *
 * (a) Q5: enabled rows with no successful request in 7 days
 *     (`provider_requests.status = 'success'`) are suspect.
 * (b) Where the upstream exposes a model list, rows absent from it
 *     are suspect. Anthropic has no list endpoint, so its rows are
 *     only covered by (a); a platform without an enabled key, or
 *     whose list fetch fails, is skipped and reported in the log.
 */
export async function runCatalogValidation(
	db: D1Database,
	options: CatalogValidationOptions = {},
): Promise<CatalogValidationSummary> {
	const now = options.now ?? Date.now();
	const maxMarked = options.maxMarked ?? DEFAULT_MAX_MARKED;
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const checkedRow = await db
		.prepare("SELECT COUNT(*) AS n FROM models WHERE enabled = 1")
		.first<{ n: number }>();
	const checked = checkedRow?.n ?? 0;
	let suspected = 0;
	const unvalidated = new Set<string>();
	const keyOf = (platform: string, modelId: string) =>
		`${platform}\u0000${modelId}`;
	const platformSkips: { platform: string; reason: string }[] = [];

	const columns = await suspectColumnsExist(db);
	if (!columns) {
		console.error(
			JSON.stringify({
				event: "catalog_validation",
				checked,
				suspected: 0,
				skipped: checked,
				reason: "suspect_columns_missing",
			}),
		);
		return { checked, suspected: 0, skipped: checked };
	}

	// (a) Rows with no success in 7 days (audit §B.7 Q5).
	const stale = await db
		.prepare(
			`SELECT m.platform, m.model_id FROM models m
			  LEFT JOIN provider_requests r
			    ON r.model_routed = m.model_id AND r.platform = m.platform
			    AND r.status = 'success' AND r.created_at > datetime('now', '-7 days')
			  WHERE m.enabled = 1 AND r.id IS NULL
			  ORDER BY m.platform, m.model_id`,
		)
		.all<{ platform: string; model_id: string }>();
	for (const row of stale.results) {
		if (suspected >= maxMarked) {
			unvalidated.add(keyOf(row.platform, row.model_id));
			continue;
		}
		if (
			await markSuspect(
				db,
				row.platform,
				row.model_id,
				SUSPECT_NO_SUCCESS_7D,
				now,
			)
		)
			suspected++;
	}

	// (b) Upstream list comparison, one call per platform. Only
	// unsuspected rows are compared: rows marked by (a) already carry
	// a verdict, and rows with a recent success were validated by (a).
	if (!options.encryptionSecret) {
		platformSkips.push({ platform: "*", reason: "no_encryption_secret" });
	} else {
		const platforms = await db
			.prepare(
				"SELECT DISTINCT platform FROM models WHERE enabled = 1 ORDER BY platform",
			)
			.all<{ platform: string }>();
		for (const { platform } of platforms.results) {
			const rows = await db
				.prepare(
					`SELECT model_id FROM models
					  WHERE platform = ? AND enabled = 1 AND suspect_reason IS NULL
					  ORDER BY model_id`,
				)
				.bind(platform)
				.all<{ model_id: string }>();
			const provider = await getProviderConfig(platform, db);
			if (!provider) {
				platformSkips.push({ platform, reason: "unknown_provider" });
				continue;
			}
			const keys = await getEnabledKeysForPlatform(
				db,
				"",
				platform,
				options.encryptionSecret,
			);
			if (keys.length === 0) {
				platformSkips.push({ platform, reason: "no_enabled_key" });
				continue;
			}
			const list = await fetchUpstreamModelList(
				provider,
				keys[0].apiKey,
				fetchImpl,
			);
			if (list.listUnsupported) {
				platformSkips.push({ platform, reason: "no_list_endpoint" });
				continue;
			}
			if (list.malformedKey) {
				platformSkips.push({ platform, reason: "malformed_key" });
				continue;
			}
			if (!list.ok) {
				platformSkips.push({
					platform,
					reason: `list_fetch_failed:${list.status ?? "network"}`,
				});
				continue;
			}
			for (const row of rows.results) {
				const key = keyOf(platform, row.model_id);
				if (list.modelIds.has(row.model_id)) {
					unvalidated.delete(key);
					continue;
				}
				if (suspected >= maxMarked) {
					unvalidated.add(key);
					continue;
				}
				if (
					await markSuspect(
						db,
						platform,
						row.model_id,
						SUSPECT_UPSTREAM_MISSING,
						now,
					)
				) {
					suspected++;
					unvalidated.delete(key);
				}
			}
		}
	}

	const skipped = unvalidated.size;
	console.error(
		JSON.stringify({
			event: "catalog_validation",
			checked,
			suspected,
			skipped,
			...(platformSkips.length > 0 ? { platformSkips } : {}),
		}),
	);
	return { checked, suspected, skipped };
}
