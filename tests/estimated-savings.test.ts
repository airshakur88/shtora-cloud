import { expect, test } from "bun:test";
import { getUserUsageMetrics } from "../src/lib/usage-metrics";
import type { MemoryD1 } from "./utils/d1-shim";
import { createParityDatabase } from "./utils/parity-database";

async function seedUser(db: MemoryD1, id: string) {
	await db
		.prepare(
			"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
		)
		.bind(id, id, `${id}@example.test`, "unused")
		.run();
}

async function recordRequest(
	db: MemoryD1,
	userId: string,
	platform: string,
	model: string,
	status: string,
	inputTokens: number | null,
	outputTokens: number | null,
): Promise<number> {
	const result = await db
		.prepare(
			`INSERT INTO provider_requests
			 (user_id, model_requested, model_routed, platform, key_id, status, input_tokens, output_tokens)
			 VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
		)
		.bind(userId, model, model, platform, status, inputTokens, outputTokens)
		.run();
	return result.meta.last_row_id;
}

test("prices successful exact model matches and uses the default for unknown models", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db, "u1");
		for (const [platform, model] of [
			["google", "gemini-2.5-flash"],
			["google", "gemini-2.5-pro"],
			["mistral", "mistral-large-latest"],
			["mistral", "codestral-latest"],
		]) {
			await recordRequest(
				db,
				"u1",
				platform,
				model,
				"success",
				1_000_000,
				1_000_000,
			);
		}
		await recordRequest(
			db,
			"u1",
			"unknown",
			"unmapped",
			"success",
			1_000_000,
			1_000_000,
		);

		expect((await getUserUsageMetrics(db, "u1")).estimatedSavingsUsd).toBe(
			18.25,
		);
	} finally {
		db.close();
	}
});

test("counts only this user's successful requests and ignores invalid token counts", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db, "u1");
		await seedUser(db, "u2");
		await recordRequest(
			db,
			"u1",
			"google",
			"gemini-2.5-flash",
			"success",
			1_000_000,
			1_000_000,
		);
		await recordRequest(
			db,
			"u1",
			"google",
			"gemini-2.5-flash",
			"error",
			9_000_000,
			9_000_000,
		);
		await recordRequest(
			db,
			"u2",
			"google",
			"gemini-2.5-flash",
			"success",
			9_000_000,
			9_000_000,
		);
		await recordRequest(db, "u1", "custom", "unknown", "success", -1, null);

		expect((await getUserUsageMetrics(db, "u1")).estimatedSavingsUsd).toBe(2.8);
		expect((await getUserUsageMetrics(db, "u2")).estimatedSavingsUsd).toBe(
			25.2,
		);
	} finally {
		db.close();
	}
});
test("saving snapshots its per-attempt rates and updates cost when token counts finalize", async () => {
	const db = await createParityDatabase();
	try {
		await seedUser(db, "u1");
		const firstId = await recordRequest(
			db,
			"u1",
			"google",
			"gemini-2.5-flash",
			"success",
			1_000_000,
			1_000_000,
		);
		await db
			.prepare(
				`UPDATE usage_metric_pricing
				 SET input_usd_per_million = 1
				 WHERE platform = 'google' AND model_routed = 'gemini-2.5-flash'`,
			)
			.run();

		expect((await getUserUsageMetrics(db, "u1")).estimatedSavingsUsd).toBe(2.8);
		await db
			.prepare("UPDATE provider_requests SET output_tokens = ? WHERE id = ?")
			.bind(2_000_000, firstId)
			.run();
		expect((await getUserUsageMetrics(db, "u1")).estimatedSavingsUsd).toBe(5.3);

		await recordRequest(
			db,
			"u1",
			"google",
			"gemini-2.5-flash",
			"success",
			1_000_000,
			1_000_000,
		);
		const rows = await db
			.prepare(
				`SELECT estimated_savings_usd, input_rate_usd_per_million
				 FROM provider_requests WHERE user_id = ? ORDER BY id`,
			)
			.bind("u1")
			.all<{
				estimated_savings_usd: number;
				input_rate_usd_per_million: number;
			}>();
		expect(rows.results).toEqual([
			{ estimated_savings_usd: 5.3, input_rate_usd_per_million: 0.3 },
			{ estimated_savings_usd: 3.5, input_rate_usd_per_million: 1 },
		]);
	} finally {
		db.close();
	}
});
