import type { D1Database } from "./types";

export type ModelSuspectReason = "bad_request" | "model_mismatch";

/**
 * Flag one catalog row as suspect: the upstream answered for a model
 * that does not exist there (bad_request, e.g. a renamed/removed
 * model_id) or for a different model (model_mismatch). The row is the
 * problem, not the key, so the key is left alone and the signal lands
 * on the model for catalog review (Phase 2 prunes/validates suspect
 * rows). suspect_since is epoch ms; a NULL suspect_reason means the
 * row was never flagged.
 *
 * The columns come from migration 0019. If it has not landed yet the
 * UPDATE throws "no such column": that failure is swallowed, because a
 * data-marking failure must never fail the client request. Any other
 * error still throws.
 */
export async function markModelSuspect(
	db: D1Database,
	platform: string,
	modelId: string,
	reason: ModelSuspectReason,
): Promise<void> {
	try {
		await db
			.prepare(
				`UPDATE models SET suspect_reason = ?, suspect_since = ?
				  WHERE platform = ? AND model_id = ?`,
			)
			.bind(reason, Date.now(), platform, modelId)
			.run();
	} catch (err) {
		if (err instanceof Error && err.message.includes("no such column")) return;
		throw err;
	}
}
