import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	observeStreamUsage,
	type StreamUsageResult,
} from "../src/lib/stream-usage";
import {
	estimateTokensFromCharacters,
	parseReportedTokenCounts,
	promptInputCharacters,
} from "../src/lib/token-estimates";
import type { ChatMessage } from "../src/lib/types";
import {
	getGlobalUsageMetrics,
	getUserUsageMetrics,
} from "../src/lib/usage-metrics";
import { MemoryD1 } from "./utils/d1-shim";

const migrations = [
	"0001_initial_schema.sql",
	"0002_backend_parity.sql",
	"0003_usage_metrics.sql",
	"0004_usage_metrics_backfill.sql",
].map((name) =>
	readFileSync(resolve(process.cwd(), "migrations", name), "utf8"),
);

function createDatabase(): MemoryD1 {
	const db = new MemoryD1();
	for (const migration of migrations) db.exec(migration);
	return db;
}

function createPreMetricsDatabase(): MemoryD1 {
	const db = new MemoryD1();
	db.exec(migrations[0]);
	db.exec(migrations[1]);
	return db;
}

async function seedUser(db: MemoryD1, id: string): Promise<void> {
	await db
		.prepare(
			"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
		)
		.bind(id, id, `${id}user`, "unused")
		.run();
}

async function insertAttempt(
	db: MemoryD1,
	userId: string,
	model: string,
	platform: string,
	status: string,
	inputTokens: number | null,
	outputTokens: number | null,
	latencyMs: number | null,
): Promise<number> {
	const result = await db
		.prepare(
			`INSERT INTO provider_requests
			 (user_id, model_requested, model_routed, platform, key_id, status,
			  input_tokens, output_tokens, latency_ms, request_id)
			 VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
		)
		.bind(
			userId,
			model,
			model,
			platform,
			status,
			inputTokens,
			outputTokens,
			latencyMs,
			crypto.randomUUID(),
		)
		.run();
	return result.meta.last_row_id;
}

test("backfills attempt totals, success rate, current-rate savings, latency histogram, and no TTFT", async () => {
	const db = createPreMetricsDatabase();
	try {
		await seedUser(db, "u1");
		await seedUser(db, "u2");
		await insertAttempt(
			db,
			"u1",
			"gemini-2.5-flash",
			"google",
			"success",
			1_000_000,
			2_000_000,
			1_234,
		);
		await insertAttempt(
			db,
			"u1",
			"unmapped",
			"unknown",
			"success",
			0,
			1_000_000,
			50,
		);
		await insertAttempt(
			db,
			"u1",
			"gemini-2.5-flash",
			"google",
			"error",
			null,
			null,
			500,
		);
		await insertAttempt(
			db,
			"u2",
			"gemini-2.5-pro",
			"google",
			"success",
			1_000_000,
			1_000_000,
			100,
		);

		db.exec(migrations[2]);
		await insertAttempt(db, "u1", "between", "unknown", "success", 0, 0, 70);
		db.exec(migrations[3]);

		const user = await getUserUsageMetrics(db, "u1");
		const global = await getGlobalUsageMetrics(db);
		expect(user).toMatchObject({
			requests: 4,
			successfulRequests: 3,
			successRate: 0.75,
			inputTokens: 1_000_000,
			outputTokens: 3_000_000,
			estimatedSavingsUsd: 6.1,
			averageLatencyMs: 463.5,
			p95LatencyMs: 1_299,
			averageTtftMs: null,
		});
		expect(global).toMatchObject({
			requests: 5,
			successfulRequests: 4,
			successRate: 0.8,
			inputTokens: 2_000_000,
			outputTokens: 4_000_000,
			estimatedSavingsUsd: 17.35,
			averageTtftMs: null,
		});
		db.exec(migrations[3]);
		expect((await getGlobalUsageMetrics(db)).requests).toBe(5);
	} finally {
		db.close();
	}
});

test("multipart input estimates count text parts and exclude image payloads", () => {
	const plain: ChatMessage[] = [{ role: "user", content: "hello world" }];
	const multipart: ChatMessage[] = [
		{
			role: "user",
			content: [
				{ type: "text", text: "hello " },
				{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
				{ type: "text", text: "world" },
			],
		},
	];

	expect(promptInputCharacters(plain)).toBe(11);
	expect(promptInputCharacters(multipart)).toBe(11);
	expect(estimateTokensFromCharacters(promptInputCharacters(multipart))).toBe(
		3,
	);
});
test("each provider attempt updates durable user and global metrics, including TTFT and cascade deletion", async () => {
	const db = createDatabase();
	try {
		await seedUser(db, "u1");
		await seedUser(db, "u2");
		expect(await getUserUsageMetrics(db, "u1")).toMatchObject({
			requests: 0,
			successRate: null,
			averageLatencyMs: null,
			p95LatencyMs: null,
			averageTtftMs: null,
		});
		await insertAttempt(
			db,
			"u1",
			"gemini-2.5-flash",
			"google",
			"rate_limited",
			null,
			null,
			20,
		);
		const successId = await insertAttempt(
			db,
			"u1",
			"gemini-2.5-flash",
			"google",
			"success",
			1_000_000,
			1_000_000,
			100,
		);
		await insertAttempt(db, "u2", "other", "unknown", "success", 2, 3, 200);

		let user = await getUserUsageMetrics(db, "u1");
		expect(user).toMatchObject({
			requests: 2,
			successfulRequests: 1,
			successRate: 0.5,
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			estimatedSavingsUsd: 2.8,
			averageLatencyMs: 60,
			p95LatencyMs: 100,
			averageTtftMs: null,
		});

		await db
			.prepare("UPDATE provider_requests SET ttft_ms = ? WHERE id = ?")
			.bind(45, successId)
			.run();
		user = await getUserUsageMetrics(db, "u1");
		expect(user.averageTtftMs).toBe(45);
		expect(user.estimatedSavingsUsd).toBe(2.8);
		expect((await getGlobalUsageMetrics(db)).estimatedSavingsUsd).toBe(2.8);
		expect((await getGlobalUsageMetrics(db)).averageTtftMs).toBe(45);

		await db.prepare("DELETE FROM user WHERE id = ?").bind("u1").run();
		expect(await getUserUsageMetrics(db, "u1")).toMatchObject({
			requests: 0,
			successRate: null,
			averageLatencyMs: null,
			p95LatencyMs: null,
			averageTtftMs: null,
		});
		expect(await getGlobalUsageMetrics(db)).toMatchObject({
			requests: 1,
			successfulRequests: 1,
			inputTokens: 2,
			outputTokens: 3,
			estimatedSavingsUsd: 0,
			averageLatencyMs: 200,
			p95LatencyMs: 200,
			averageTtftMs: null,
		});
	} finally {
		db.close();
	}
});
test("p95 maps histogram buckets to millisecond upper bounds and queries overflow exactly", async () => {
	const db = createDatabase();
	try {
		const cases = [
			["u999", 999, 999],
			["u1000", 1_000, 1_099],
			["u1099", 1_099, 1_099],
			["u1100", 1_100, 1_199],
			["u120099", 120_099, 120_099],
			["u120100", 120_100, 120_100],
			["u120500", 120_500, 120_500],
		] as const;
		for (const [userId, latencyMs] of cases) {
			await seedUser(db, userId);
			await insertAttempt(
				db,
				userId,
				"model",
				"provider",
				"success",
				0,
				0,
				latencyMs,
			);
		}
		for (const [userId, , expectedP95] of cases) {
			expect((await getUserUsageMetrics(db, userId)).p95LatencyMs).toBe(
				expectedP95,
			);
		}
		expect((await getGlobalUsageMetrics(db)).p95LatencyMs).toBe(120500);
	} finally {
		db.close();
	}
});

test("streamed provider usage is captured across split SSE chunks", async () => {
	const encoder = new TextEncoder();
	const wire = [
		": keepalive\n\n",
		'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
		'data: {"choices":[{"delta":{"content":"first token"}}]}\n\n',
		'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":7}}\n\n',
		"data: [DONE]\n\n",
	].join("");
	const bytes = encoder.encode(wire);
	const splitAt = wire.indexOf('"content"') + 5;
	const source = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes.subarray(0, splitAt));
			controller.enqueue(bytes.subarray(splitAt));
			controller.close();
		},
	});
	const captured: { usage?: StreamUsageResult } = {};
	const received = await new Response(
		observeStreamUsage(source, 8, performance.now(), (result) => {
			captured.usage = result;
		}),
	).text();

	expect(received).toBe(wire);
	expect(captured.usage).toMatchObject({
		inputTokens: 12,
		outputTokens: 7,
		inputTokensEstimated: false,
		outputTokensEstimated: false,
	});
	expect(captured.usage?.ttftMs).not.toBeNull();
});

test("usage-less CR-only stream estimates text and tool arguments", async () => {
	const wire = [
		'data: {"choices":[{"delta":{"content":"hello"}}]}',
		"",
		'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{\\"a\\":1}"}}]}}]}',
		"",
		"data: [DONE]",
		"",
	].join("\r");
	const captured: { usage?: StreamUsageResult } = {};
	const received = await new Response(
		observeStreamUsage(
			new Response(wire).body as ReadableStream<Uint8Array>,
			9,
			performance.now(),
			(result) => {
				captured.usage = result;
			},
		),
	).text();

	expect(received).toBe(wire);
	expect(captured.usage).toMatchObject({
		inputTokens: 9,
		outputTokens: estimateTokensFromCharacters(12),
		inputTokensEstimated: true,
		outputTokensEstimated: true,
	});
	expect(captured.usage?.ttftMs).not.toBeNull();
});

test("empty streams have no TTFT and analytics failures do not break the response", async () => {
	const empty = await new Response(
		observeStreamUsage(
			new Response('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n')
				.body as ReadableStream<Uint8Array>,
			2,
			performance.now(),
			(usage) => {
				expect(usage.ttftMs).toBeNull();
			},
		),
	).text();
	expect(empty).toContain('"role":"assistant"');

	const wire = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n';
	const source = new Response(wire).body;
	if (!source) throw new Error("Test response has no body");
	const received = await new Response(
		observeStreamUsage(source, 1, performance.now(), () => {
			throw new Error("D1 unavailable");
		}),
	).text();
	expect(received).toBe(wire);
});
test("cancelling a stream forwards cancellation and persists observed output", async () => {
	const wire = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n';
	let sourceCancelled = false;
	const captured: { usage?: StreamUsageResult } = {};
	const source = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(wire));
		},
		cancel() {
			sourceCancelled = true;
		},
	});
	const reader = observeStreamUsage(source, 2, performance.now(), (result) => {
		captured.usage = result;
	}).getReader();

	const first = await reader.read();
	expect(new TextDecoder().decode(first.value)).toBe(wire);
	await reader.cancel();

	expect(sourceCancelled).toBe(true);
	expect(captured.usage).toMatchObject({
		inputTokens: 2,
		outputTokens: 2,
		inputTokensEstimated: true,
		outputTokensEstimated: true,
	});
	expect(captured.usage?.ttftMs).not.toBeNull();
});

test("malformed provider token counts are rejected", () => {
	expect(
		parseReportedTokenCounts({
			prompt_tokens: -1,
			completion_tokens: Number.NaN,
		}),
	).toEqual({
		inputTokens: null,
		outputTokens: null,
		estimated: false,
	});
});
