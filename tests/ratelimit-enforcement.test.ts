import { expect, test } from "bun:test";
import { createApiKey } from "../src/lib/key-store";
import {
	canMakeRequest,
	checkFixedWindowLimit,
	checkImageUploadLimit,
	checkInvalidTokenLimit,
	checkPublicInferenceLimit,
	DEFAULT_RATE_LIMITS,
	getClientIp,
	PUBLIC_INFERENCE_LIMITS,
	recordUsage,
} from "../src/lib/ratelimit";
import type { MemoryD1 } from "./utils/d1-shim";
import { createParityDatabase } from "./utils/parity-database";

// Public inference + per-key rate-limit enforcement (A2, M29). These
// reconstruct the focused tests the phase-1 security agent ran in a
// temporary file: fixed-window counters per token/IP/invalid attempts,
// the per-(key, model) enforcer, and the upload limiter.
//
// The helpers are wired into the routes in
// tests/public-inference-ratelimit.test.ts, which calls the real POST
// handlers: a valid token past its per-token cap answers 429, and an
// invalid token past its per-IP cap answers 429 instead of 401.

// provider_rate_limit_usage.key_id references api_keys(id), so usage rows
// need a real key. The enforcer itself only reads the usage table.
async function seedKeyId(db: MemoryD1): Promise<number> {
	await db
		.prepare(
			"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
		)
		.bind("u1", "Test User", "testuser", "hash")
		.run();
	const key = await createApiKey(
		db,
		{
			userId: "u1",
			platform: "groq",
			rawKey: "gsk-ratelimit",
			keyLabel: null,
		},
		"ratelimit-test-secret-0123456789-abcdefghij",
	);
	return key.id;
}

test("fixed-window counter allows up to the limit, then blocks with a retry delay", async () => {
	const db = await createParityDatabase();
	try {
		for (let i = 0; i < 3; i += 1) {
			expect(
				(
					await checkFixedWindowLimit(db, {
						scope: "test",
						id: "u1",
						limit: 3,
					})
				).ok,
			).toBe(true);
		}
		const blocked = await checkFixedWindowLimit(db, {
			scope: "test",
			id: "u1",
			limit: 3,
		});
		expect(blocked.ok).toBe(false);
		expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
		expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
		// A different id has its own bucket.
		expect(
			(
				await checkFixedWindowLimit(db, {
					scope: "test",
					id: "u2",
					limit: 3,
				})
			).ok,
		).toBe(true);
	} finally {
		db.close();
	}
});

test("fixed-window counter resets after the window passes", async () => {
	const db = await createParityDatabase();
	try {
		const input = {
			scope: "test",
			id: "u1",
			limit: 1,
			windowMs: 50,
		};
		expect((await checkFixedWindowLimit(db, input)).ok).toBe(true);
		expect((await checkFixedWindowLimit(db, input)).ok).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect((await checkFixedWindowLimit(db, input)).ok).toBe(true);
	} finally {
		db.close();
	}
});

test("per-token public inference cap blocks the 121st request in a minute", async () => {
	const db = await createParityDatabase();
	try {
		for (let i = 0; i < PUBLIC_INFERENCE_LIMITS.perTokenRpm; i += 1) {
			expect(
				(
					await checkPublicInferenceLimit(db, {
						userId: "token-owner",
						ip: "10.0.0.1",
					})
				).ok,
			).toBe(true);
		}
		const blocked = await checkPublicInferenceLimit(db, {
			userId: "token-owner",
			ip: "10.0.0.1",
		});
		expect(blocked).toEqual({
			ok: false,
			scope: "token",
			retryAfterSeconds: expect.any(Number),
		});
		// Another token is unaffected by the first token's cap.
		expect(
			(
				await checkPublicInferenceLimit(db, {
					userId: "other-owner",
					ip: "10.0.0.1",
				})
			).ok,
		).toBe(true);
	} finally {
		db.close();
	}
});

test("per-IP public inference cap blocks the 301st request from one IP across tokens", async () => {
	const db = await createParityDatabase();
	try {
		for (let i = 0; i < PUBLIC_INFERENCE_LIMITS.perIpRpm; i += 1) {
			expect(
				(
					await checkPublicInferenceLimit(db, {
						// Fresh token each time so the per-token cap never binds.
						userId: `token-${i}`,
						ip: "10.0.0.2",
					})
				).ok,
			).toBe(true);
		}
		const blocked = await checkPublicInferenceLimit(db, {
			userId: "token-301",
			ip: "10.0.0.2",
		});
		expect(blocked.ok).toBe(false);
		expect(blocked.scope).toBe("ip");
		// Another IP is unaffected.
		expect(
			(
				await checkPublicInferenceLimit(db, {
					userId: "token-301",
					ip: "10.0.0.3",
				})
			).ok,
		).toBe(true);
	} finally {
		db.close();
	}
});

test("invalid-token attempts are capped at 20 per minute per IP", async () => {
	const db = await createParityDatabase();
	try {
		for (let i = 0; i < PUBLIC_INFERENCE_LIMITS.invalidTokenRpm; i += 1) {
			expect((await checkInvalidTokenLimit(db, { ip: "10.0.0.9" })).ok).toBe(
				true,
			);
		}
		const blocked = await checkInvalidTokenLimit(db, { ip: "10.0.0.9" });
		expect(blocked).toEqual({
			ok: false,
			scope: "invalid_token",
			retryAfterSeconds: expect.any(Number),
		});
	} finally {
		db.close();
	}
});

test("image uploads are capped at 20 per minute per user", async () => {
	const db = await createParityDatabase();
	try {
		for (let i = 0; i < PUBLIC_INFERENCE_LIMITS.imageUploadRpm; i += 1) {
			expect((await checkImageUploadLimit(db, { userId: "uploader" })).ok).toBe(
				true,
			);
		}
		const blocked = await checkImageUploadLimit(db, { userId: "uploader" });
		expect(blocked).toEqual({
			ok: false,
			scope: "upload",
			retryAfterSeconds: expect.any(Number),
		});
		expect(
			(await checkImageUploadLimit(db, { userId: "someone-else" })).ok,
		).toBe(true);
	} finally {
		db.close();
	}
});

test("getClientIp reads cf-connecting-ip and falls back to loopback", () => {
	expect(
		getClientIp(
			new Request("http://localhost/", {
				headers: { "cf-connecting-ip": "203.0.113.7" },
			}),
		),
	).toBe("203.0.113.7");
	expect(getClientIp(new Request("http://localhost/"))).toBe("127.0.0.1");
});

test("per-(key, model) enforcer blocks the 61st request per minute at the default rpm", async () => {
	const db = await createParityDatabase();
	try {
		const keyId = await seedKeyId(db);
		const input = {
			platform: "groq",
			modelId: "model-a",
			keyId,
			estTokens: 10,
		};
		for (let i = 0; i < DEFAULT_RATE_LIMITS.rpm; i += 1) {
			expect((await canMakeRequest(db, input)).ok).toBe(true);
			await recordUsage(db, {
				platform: "groq",
				modelId: "model-a",
				keyId,
				inputTokens: 10,
				outputTokens: 0,
			});
		}
		expect(await canMakeRequest(db, input)).toEqual({
			ok: false,
			reason: "rpm",
		});
		// Another model on the same key has its own bucket.
		expect(
			(await canMakeRequest(db, { ...input, modelId: "model-b" })).ok,
		).toBe(true);
	} finally {
		db.close();
	}
});

test("per-(key, model) enforcer blocks on token budget before the request cap", async () => {
	const db = await createParityDatabase();
	try {
		const keyId = await seedKeyId(db);
		const input = {
			platform: "groq",
			modelId: "model-a",
			keyId,
			estTokens: 900,
			tpmLimit: 1000,
		};
		expect((await canMakeRequest(db, input)).ok).toBe(true);
		await recordUsage(db, {
			platform: "groq",
			modelId: "model-a",
			keyId,
			inputTokens: 200,
			outputTokens: 0,
		});
		// 200 already used + 900 estimated exceeds the 1000 tpm cap.
		expect(await canMakeRequest(db, input)).toEqual({
			ok: false,
			reason: "tpm",
		});
	} finally {
		db.close();
	}
});

test("per-(key, model) enforcer blocks on the daily request cap", async () => {
	const db = await createParityDatabase();
	try {
		const keyId = await seedKeyId(db);
		const input = {
			platform: "groq",
			modelId: "model-a",
			keyId,
			estTokens: 10,
			rpdLimit: 2,
		};
		for (let i = 0; i < 2; i += 1) {
			await recordUsage(db, {
				platform: "groq",
				modelId: "model-a",
				keyId,
				inputTokens: 10,
				outputTokens: 0,
			});
		}
		expect(await canMakeRequest(db, input)).toEqual({
			ok: false,
			reason: "rpd",
		});
	} finally {
		db.close();
	}
});
