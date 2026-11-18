import type { D1Database, D1Value } from "@/lib/types";

const MINUTE_MS = 60_000;
const DEFAULT_RPM = 60;
const DEFAULT_TPM = 200_000;
const DEFAULT_RPD = 5_000;
const DEFAULT_TPD = 5_000_000;

function utcMidnightMs(now: number): number {
	const date = new Date(now);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

async function count(
	db: D1Database,
	sql: string,
	values: D1Value[],
): Promise<number> {
	const row = await db
		.prepare(sql)
		.bind(...values)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

export async function canMakeRequest(
	db: D1Database,
	input: {
		platform: string;
		modelId: string;
		keyId: number;
		estTokens: number;
		rpmLimit?: number | null;
		tpmLimit?: number | null;
		rpdLimit?: number | null;
		tpdLimit?: number | null;
	},
): Promise<{ ok: boolean; reason?: string }> {
	const now = Date.now();
	const minuteStart = now - MINUTE_MS;
	const dayStart = utcMidnightMs(now);
	const where =
		"platform = ? AND model_id = ? AND key_id = ? AND kind = ? AND created_at_ms > ?";
	const [requestsMinute, tokensMinute, requestsDay, tokensDay] =
		await Promise.all([
			count(
				db,
				`SELECT COUNT(*) AS n FROM provider_rate_limit_usage WHERE ${where}`,
				[input.platform, input.modelId, input.keyId, "request", minuteStart],
			),
			count(
				db,
				`SELECT COALESCE(SUM(tokens), 0) AS n FROM provider_rate_limit_usage WHERE ${where}`,
				[input.platform, input.modelId, input.keyId, "tokens", minuteStart],
			),
			count(
				db,
				`SELECT COUNT(*) AS n FROM provider_rate_limit_usage WHERE ${where}`,
				[input.platform, input.modelId, input.keyId, "request", dayStart],
			),
			count(
				db,
				`SELECT COALESCE(SUM(tokens), 0) AS n FROM provider_rate_limit_usage WHERE ${where}`,
				[input.platform, input.modelId, input.keyId, "tokens", dayStart],
			),
		]);
	const rpm = input.rpmLimit ?? DEFAULT_RPM;
	const tpm = input.tpmLimit ?? DEFAULT_TPM;
	const rpd = input.rpdLimit ?? DEFAULT_RPD;
	const tpd = input.tpdLimit ?? DEFAULT_TPD;
	if (requestsMinute >= rpm) return { ok: false, reason: "rpm" };
	if (tokensMinute + input.estTokens > tpm) return { ok: false, reason: "tpm" };
	if (requestsDay >= rpd) return { ok: false, reason: "rpd" };
	if (tokensDay + input.estTokens > tpd) return { ok: false, reason: "tpd" };
	return { ok: true };
}

export interface UsageReservation {
	rowId: number;
	createdAtMs: number;
	keyId: number;
	platform: string;
	modelId: string;
}

export async function finalizeUsage(
	db: D1Database,
	receipt: UsageReservation,
	tokens: number,
): Promise<void> {
	if (!Number.isSafeInteger(tokens) || tokens < 0)
		throw new Error("Invalid token total");
	await db
		.prepare(
			"UPDATE provider_rate_limit_usage SET tokens = ? WHERE rowid = ? AND created_at_ms = ? AND key_id = ? AND platform = ? AND model_id = ? AND kind = 'tokens'",
		)
		.bind(
			tokens,
			receipt.rowId,
			receipt.createdAtMs,
			receipt.keyId,
			receipt.platform,
			receipt.modelId,
		)
		.run();
}

export async function recordUsage(
	db: D1Database,
	input: {
		platform: string;
		modelId: string;
		keyId: number;
		inputTokens: number;
		outputTokens: number;
	},
): Promise<UsageReservation> {
	const now = Date.now();
	await db
		.prepare(
			"INSERT INTO provider_rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms) VALUES (?, ?, ?, 'request', NULL, ?)",
		)
		.bind(input.platform, input.modelId, input.keyId, now)
		.run();
	const row = await db
		.prepare(
			"INSERT INTO provider_rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms) VALUES (?, ?, ?, 'tokens', ?, ?) RETURNING rowid AS id",
		)
		.bind(
			input.platform,
			input.modelId,
			input.keyId,
			input.inputTokens + input.outputTokens,
			now,
		)
		.first<{ id: number }>();
	if (!row) throw new Error("Usage reservation unavailable");
	return {
		rowId: row.id,
		createdAtMs: now,
		keyId: input.keyId,
		platform: input.platform,
		modelId: input.modelId,
	};
}
