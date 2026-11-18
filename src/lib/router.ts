/**
 * Model router: builds a fallback chain for the requested model, scores it
 * with Thompson Sampling (7-day decayed stats, jittered per-component
 * samples) under the configured strategy, and walks chain x keys until an
 * upstream accepts the request. Attempts are recorded in provider_requests.
 * Failures are attributed to the provider, key pool, or model.
 */

import {
	canTranslateNative,
	type NativeMessagesRequest,
} from "./anthropic-request";
import {
	nativeOutputCharacters,
	nativeTokenCounts,
	translateNativeResponse,
	translateNativeStream,
} from "./anthropic-response";
import { anthropicError, readInferenceJson } from "./inference-http";
import { getEnabledKeysForPlatform, updateKeyHealth } from "./key-store";
import {
	canonicalModelId,
	isRouterModel,
	stripRouterPrefix,
} from "./model-canonical";
import catalogJson from "./models-catalog.json";
import { getProviderConfig } from "./provider-catalog";
import { ProviderError, sendChat, sendNativeMessages } from "./providers";
import type { FailureSource } from "./quarantine";
import {
	isKeyQuarantined,
	reportFailure,
	resetKeyFailures,
} from "./quarantine";
import { canMakeRequest, finalizeUsage, recordUsage } from "./ratelimit";
import { observeStreamUsage } from "./stream-usage";
import {
	completionOutputCharacters,
	estimateTokensFromCharacters,
	isValidTokenCount,
	parseCompletionTokenCounts,
	promptInputCharacters,
} from "./token-estimates";
import type {
	AppUser,
	ChatCompletionRequest,
	D1Database,
	ModelsCatalog,
} from "./types";

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export interface RouteResult {
	response: Response;
	modelId: string;
	platform: string;
	keyId: number;
	attempts: number;
}

/** Structural view of DecryptedPlatformKey from ./key-store. */
interface PlatformKey {
	id: number;
	apiKey: string;
	baseUrl: string | null;
	rpmLimit: number | null;
	tpmLimit: number | null;
	rpdLimit: number | null;
	tpdLimit: number | null;
}

interface RouterModel {
	id: number;
	model_id: string;
	platform: string;
	tier: number;
	intelligence_rank: number | null;
	supports_tools: number;
	supports_vision: number;
}

interface PlatformTally {
	serverTimeoutFails: number;
	failedKeyIds: Set<number>;
}

type Attribution = "provider_moment" | "key_exhausted" | "model_error";

// ---------------------------------------------------------------------------
// Constants (immutable)
// ---------------------------------------------------------------------------

const CHAIN_CAP = 6;
const UPSTREAM_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_TOKENS = 1024;
const DAY_MS = 86_400_000;

const STRATEGY_WEIGHTS: Record<
	string,
	{ reliability: number; speed: number; intelligence: number; budget: number }
> = {
	balanced: {
		reliability: 0.25,
		speed: 0.25,
		intelligence: 0.25,
		budget: 0.25,
	},
	smartest: { reliability: 0.7, speed: 0.1, intelligence: 0.1, budget: 0.1 },
	fastest: { reliability: 0.1, speed: 0.7, intelligence: 0.1, budget: 0.1 },
	reliable: { reliability: 0.7, speed: 0.1, intelligence: 0.1, budget: 0.1 },
};

const SOURCE_BY_KIND: Record<string, FailureSource> = {
	rate_limit: "rate_limit",
	payment: "payment",
	forbidden: "tier",
	auth: "auth_error",
	server: "server_error",
	timeout: "timeout",
	network: "server_error",
};

const HEALTH_BY_KIND: Record<
	string,
	"healthy" | "rate_limited" | "invalid" | "error"
> = {
	rate_limit: "rate_limited",
	auth: "invalid",
	payment: "error",
	forbidden: "error",
	server: "error",
	timeout: "error",
	network: "error",
};

/** Catalog platform ids: upstream base URL comes from the catalog Map. */
const CATALOG_PLATFORMS: ReadonlySet<string> = new Set<string>(
	(catalogJson as unknown as ModelsCatalog).providers.map((p) => p.id),
);

// ---------------------------------------------------------------------------
// Chain
// ---------------------------------------------------------------------------

function isMatch(model: RouterModel, requested: string): boolean {
	if (
		model.model_id === requested ||
		`${model.platform}/${model.model_id}` === requested
	)
		return true;
	if (isRouterModel(requested)) {
		const bare = stripRouterPrefix(requested);
		return canonicalModelId(model.model_id) === canonicalModelId(bare);
	}
	return false;
}

/**
 * Matching model first (by model_id or 'platform/model_id'); the rest ordered
 * by tier asc, intelligence_rank asc with NULLS last, id asc; capped at 6.
 */
function buildChain(models: RouterModel[], requested: string): RouterModel[] {
	return models
		.map((model) => ({ model, key: isMatch(model, requested) ? 0 : 1 }))
		.sort(
			(a, b) =>
				a.key - b.key ||
				a.model.tier - b.model.tier ||
				(a.model.intelligence_rank === null ? 1 : 0) -
					(b.model.intelligence_rank === null ? 1 : 0) ||
				(a.model.intelligence_rank ?? 0) - (b.model.intelligence_rank ?? 0) ||
				a.model.id - b.model.id,
		)
		.slice(0, CHAIN_CAP)
		.map((entry) => entry.model);
}

// ---------------------------------------------------------------------------
// Thompson sampling over the last 7 days of provider request history
// ---------------------------------------------------------------------------

function percentile50(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[mid - 1] + sorted[mid]) / 2
		: sorted[mid];
}

/** `datetime('now')` UTC in SQLite's wire format (YYYY-MM-DD HH:MM:SS). */
function toSqliteDate(ms: number): string {
	return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

function fromSqliteDate(value: string): number {
	const ms = Date.parse(`${value.replace(" ", "T")}Z`);
	return Number.isNaN(ms) ? Date.now() : ms;
}

/**
 * Score each chain model from the last 7 days of `provider_requests` with a 2-day
 * half-life: each row weighs 0.5^(age_days/2); reliability = weighted
 * success rate (0.5 with no data); speed = 1 - min(1, p50(latency)/5000)
 * per model over non-null latencies (0.5 with no data); intelligence =
 * 1/(1+(intelligence_rank ?? 10)); budget = 1. Each component is sampled as
 * component * (0.8 + 0.4 * Math.random()) — a uniform jitter that IS the
 * Thompson Sampling exploration — and the score is the weighted sum of the
 * samples. The requested model stays pinned at the head of the chain; the
 * rest is re-ordered by score desc (strategy 'priority' keeps chain order).
 */
async function scoreChain(
	db: D1Database,
	chain: RouterModel[],
	strategy: string,
	requested: string,
): Promise<{ chain: RouterModel[]; scores: Record<string, number> }> {
	if (strategy === "priority") {
		return {
			chain,
			scores: Object.fromEntries(chain.map((model) => [model.model_id, 1])),
		};
	}
	const weights = STRATEGY_WEIGHTS[strategy] ?? STRATEGY_WEIGHTS.balanced;

	const since = toSqliteDate(Date.now() - 7 * DAY_MS);
	const rows = (
		await db
			.prepare(
				`SELECT model_routed AS model_id, status, latency_ms, created_at FROM provider_requests
         WHERE created_at > ?
         ORDER BY created_at DESC`,
			)
			.bind(since)
			.all<{
				model_id: string;
				status: string;
				latency_ms: number | null;
				created_at: string;
			}>()
	).results;

	const now = Date.now();
	const latenciesByModel = new Map<string, number[]>();
	let totalWeight = 0;
	let successWeight = 0;
	for (const row of rows) {
		const weight =
			0.5 ** (Math.max(0, now - fromSqliteDate(row.created_at)) / DAY_MS / 2);
		totalWeight += weight;
		if (row.status === "success") successWeight += weight;
		if (row.latency_ms !== null) {
			const list = latenciesByModel.get(row.model_id) ?? [];
			list.push(row.latency_ms);
			latenciesByModel.set(row.model_id, list);
		}
	}
	const reliability = totalWeight > 0 ? successWeight / totalWeight : 0.5;

	let scored = chain.map((model) => {
		const latencies = latenciesByModel.get(model.model_id) ?? [];
		const speed =
			latencies.length > 0
				? 1 - Math.min(1, percentile50(latencies) / 5000)
				: 0.5;
		const intelligence = 1 / (1 + (model.intelligence_rank ?? 10));
		const budget = 1;
		// Uniform jitter in [0.8, 1.2]: the Thompson Sampling exploration.
		const sample = (component: number) =>
			component * (0.8 + 0.4 * Math.random());
		const score =
			weights.reliability * sample(reliability) +
			weights.speed * sample(speed) +
			weights.intelligence * sample(intelligence) +
			weights.budget * sample(budget);
		return { model, score };
	});
	scored.sort((a, b) => b.score - a.score);
	// All models matching the request stay pinned at the head of the failover
	// chain — for shtora/<model> that is every provider exposing the logical
	// model — so a provider error fails over transparently. Sampling only
	// reorders the alternatives that follow.
	const matches = scored.filter((entry) => isMatch(entry.model, requested));
	if (matches.length) {
		const matchSet = new Set(matches);
		scored = scored.filter((entry) => !matchSet.has(entry));
		scored.unshift(...matches);
	}
	return {
		chain: scored.map((entry) => entry.model),
		scores: Object.fromEntries(
			scored.map((entry) => [entry.model.model_id, entry.score]),
		),
	};
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function insertRequest(
	db: D1Database,
	p: {
		user: AppUser;
		requested: string;
		modelId: string;
		platform: string;
		keyId: number;
		status: "success" | "error" | "timeout" | "rate_limited";
		statusCode: number | null;
		errorMessage: string | null;
		inputTokens: number | null;
		outputTokens: number | null;
		inputTokensEstimated: number | null;
		outputTokensEstimated: number | null;
		latencyMs: number;
		routingDecision: unknown;
		failureAttribution: Attribution | null;
	},
): Promise<string> {
	const requestId = crypto.randomUUID();
	await db
		.prepare(
			`INSERT INTO provider_requests
			 (user_id, unified_token_id, model_requested, model_routed, platform, key_id,
			  status, status_code, error_message, input_tokens, output_tokens,
			  input_tokens_estimated, output_tokens_estimated, latency_ms,
			  routing_decision, failure_attribution, request_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			p.user.id,
			p.keyId,
			p.requested,
			p.modelId,
			p.platform,
			p.keyId,
			p.status,
			p.statusCode,
			p.errorMessage,
			p.inputTokens,
			p.outputTokens,
			p.inputTokensEstimated,
			p.outputTokensEstimated,
			p.latencyMs,
			JSON.stringify(p.routingDecision),
			p.failureAttribution,
			requestId,
		)
		.run();
	return requestId;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function routeChatCompletion(args: {
	db: D1Database;
	secret: string;
	user: AppUser;
	request: ChatCompletionRequest;
	native?: NativeMessagesRequest;
	signal?: AbortSignal;
}): Promise<RouteResult> {
	const { db, secret, user, request } = args;
	const requested = request.model;
	const stream = request.stream === true;

	// 1. Chain
	const modelsResult = await db
		.prepare(
			"SELECT id, platform, model_id, tier, intelligence_rank, supports_tools, supports_vision FROM models WHERE enabled = 1",
		)
		.all<Record<string, unknown>>();
	const models: RouterModel[] = modelsResult.results.map((row) => ({
		id: row.id as number,
		model_id: row.model_id as string,
		platform: row.platform as string,
		tier: (row.tier as number | null) ?? 1,
		intelligence_rank: (row.intelligence_rank as number | null) ?? null,
		supports_tools: Number(row.supports_tools ?? 0),
		supports_vision: Number(row.supports_vision ?? 0),
	}));
	const native = args.native;
	const needsTools =
		(request.tools?.length ?? 0) > 0 ||
		request.messages.some(
			(message) => message.tool_calls?.length || message.role === "tool",
		);
	const needsVision = request.messages.some(
		(message) =>
			Array.isArray(message.content) &&
			message.content.some((part) => part.type === "image_url"),
	);
	const compatibleModels = models.filter((model) => {
		if (native) {
			const direct =
				getProviderConfig(model.platform)?.protocol === "anthropic_messages";
			if (requested !== "auto" && !isMatch(model, requested)) return false;
			if (
				(native.operation === "count_tokens" || native.bound) &&
				requested === "auto"
			)
				return false;
			if (
				!direct &&
				!canTranslateNative(native, getProviderConfig(model.platform))
			)
				return false;
			if (direct) return true;
		}
		return (
			(!needsTools || model.supports_tools === 1) &&
			(!needsVision || model.supports_vision === 1)
		);
	});
	if (native) {
		const selected = models.filter((model) => isMatch(model, requested));
		const response =
			requested !== "auto" && !selected.length
				? anthropicError("Unknown or disabled model", 404, "not_found_error")
				: !compatibleModels.length
					? anthropicError(
							"Requested model cannot preserve these native content blocks or options; token counting and bound state require an explicit model",
						)
					: null;
		if (response)
			return {
				response,
				modelId: requested,
				platform: "",
				keyId: 0,
				attempts: 0,
			};
	}
	if ((needsTools || needsVision) && compatibleModels.length === 0) {
		return {
			response: Response.json(
				{
					error: {
						message: "No available model supports the requested features",
						type: "invalid_request_error",
						code: null,
					},
				},
				{ status: 400 },
			),
			modelId: requested,
			platform: "",
			keyId: 0,
			attempts: 0,
		};
	}

	// 2. Strategy + Thompson sampling (reorders the chain, except 'priority')
	const settingRow = await db
		.prepare("SELECT value FROM settings WHERE key = 'routing_strategy'")
		.bind()
		.first<{ value: string }>();
	const strategy = settingRow?.value ?? "balanced";
	const { chain, scores } = await scoreChain(
		db,
		buildChain(compatibleModels, requested),
		strategy,
		requested,
	);

	let attempts = 0;
	const alternativesTried: string[] = [];
	const routingDecision = { strategy, scores, alternativesTried };
	const platformTallies = new Map<string, PlatformTally>();
	let lastNativeError: Response | undefined;
	let throttled = false;

	const estInputTokens = estimateTokensFromCharacters(
		native ? native.inputCharacters : promptInputCharacters(request.messages),
	);
	const estTokens =
		estInputTokens + (request.max_tokens ?? DEFAULT_OUTPUT_TOKENS);

	for (const model of chain) {
		if (attempts >= CHAIN_CAP) break;

		let keys: PlatformKey[] = [];
		try {
			keys = await getEnabledKeysForPlatform(
				db,
				user.id,
				model.platform,
				secret,
			);
		} catch {
			keys = [];
		}
		if (native?.bound) keys = keys.slice(0, 1);
		if (keys.length === 0) {
			if (!alternativesTried.includes(model.model_id))
				alternativesTried.push(model.model_id);
			continue;
		}

		for (const key of keys) {
			if (attempts >= CHAIN_CAP) break;
			if (await isKeyQuarantined(db, model.platform, model.model_id, key.id))
				continue;
			const allowed = await canMakeRequest(db, {
				platform: model.platform,
				modelId: model.model_id,
				keyId: key.id,
				estTokens,
				rpmLimit: key.rpmLimit,
				tpmLimit: key.tpmLimit,
				rpdLimit: key.rpdLimit,
				tpdLimit: key.tpdLimit,
			});
			if (!allowed.ok) {
				throttled = true;
				continue;
			}

			attempts += 1;
			const start = Date.now();
			const attemptStartedAt = performance.now();

			let response: Response;
			const controller = new AbortController();
			const signal = args.signal
				? AbortSignal.any([args.signal, controller.signal])
				: controller.signal;
			const timeout = setTimeout(
				() =>
					controller.abort(
						new DOMException("Upstream timed out", "TimeoutError"),
					),
				UPSTREAM_TIMEOUT_MS,
			);
			try {
				const input = {
					platform: model.platform,
					modelId: model.model_id,
					apiKey: key.apiKey,
					baseUrl: CATALOG_PLATFORMS.has(model.platform) ? null : key.baseUrl,
					messages: request.messages,
					stream,
					temperature: request.temperature,
					maxTokens: request.max_tokens,
					tools: request.tools,
					stop: request.stop,
					toolChoice: request.tool_choice,
					parallelToolCalls: request.parallel_tool_calls,
				};
				const direct =
					native &&
					getProviderConfig(model.platform)?.protocol === "anthropic_messages";
				response = direct
					? await sendNativeMessages(input, native, signal)
					: await sendChat(input, signal);
				clearTimeout(timeout);
				if (native && !stream) {
					const data = await readInferenceJson(response);
					if (direct) {
						if (
							!data ||
							typeof data !== "object" ||
							(native.operation === "count_tokens"
								? !("input_tokens" in data) ||
									!isValidTokenCount(data.input_tokens)
								: !("type" in data) || data.type !== "message")
						)
							throw new ProviderError(
								"Invalid native upstream response",
								502,
								"server",
							);
						response = Response.json(data, { headers: response.headers });
					} else
						response = translateNativeResponse(
							data,
							model.model_id,
							estInputTokens,
						);
				} else if (native && !direct) {
					if (!response.body)
						throw new ProviderError("Empty upstream stream", 502, "server");
					response = translateNativeStream(
						response.body,
						model.model_id,
						estInputTokens,
					);
				}
			} catch (err) {
				clearTimeout(timeout);
				if (args.signal?.aborted) {
					if (native?.operation !== "count_tokens")
						await insertRequest(db, {
							user,
							requested,
							modelId: model.model_id,
							platform: model.platform,
							keyId: key.id,
							status: "error",
							statusCode: 499,
							errorMessage: "Request cancelled",
							inputTokens: null,
							outputTokens: null,
							inputTokensEstimated: null,
							outputTokensEstimated: null,
							latencyMs: Date.now() - start,
							routingDecision,
							failureAttribution: null,
						});
					return {
						response: anthropicError("Request cancelled", 499, "api_error"),
						modelId: model.model_id,
						platform: model.platform,
						keyId: key.id,
						attempts,
					};
				}
				const providerError =
					err instanceof ProviderError
						? err
						: new ProviderError("Upstream request failed", 0, "network");
				if (native) {
					lastNativeError = providerError.nativeResponse;
					await handleFailure(
						db,
						user,
						requested,
						model,
						key,
						providerError,
						start,
						routingDecision,
						platformTallies,
						native.operation !== "count_tokens",
					);
					if (providerError.kind === "bad_request") {
						// Do not return raw upstream errors — log and move on.
						await handleFailure(
							db,
							user,
							requested,
							model,
							key,
							providerError,
							start,
							routingDecision,
							platformTallies,
							false,
						);
					}
					continue;
				}
				if (providerError.kind === "bad_request") {
					// Record the failure and try the next provider/key instead
					// of leaking an upstream-specific error to the client.
					await handleFailure(
						db,
						user,
						requested,
						model,
						key,
						providerError,
						start,
						routingDecision,
						platformTallies,
					);
					continue;
				}
				await handleFailure(
					db,
					user,
					requested,
					model,
					key,
					providerError,
					start,
					routingDecision,
					platformTallies,
				);
				continue;
			}

			if (native?.operation === "count_tokens") {
				await db
					.prepare(
						"INSERT INTO provider_rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms) VALUES (?, ?, ?, 'request', NULL, ?)",
					)
					.bind(model.platform, model.model_id, key.id, Date.now())
					.run();
				return {
					response,
					modelId: model.model_id,
					platform: model.platform,
					keyId: key.id,
					attempts,
				};
			}
			const latencyMs = Date.now() - start;

			// Non-stream only: read the body for real usage (a stream body must
			// never be consumed here — it would be lost).
			let out: Response = response;
			let inputTokens = estInputTokens;
			let outputTokens = 0;
			let inputTokensEstimated = 1;
			let outputTokensEstimated = 1;
			if (!stream) {
				const body = new Uint8Array(await response.arrayBuffer());
				out = new Response(body, {
					status: response.status,
					headers: response.headers,
				});
				let parsed: unknown = null;
				try {
					parsed = JSON.parse(new TextDecoder().decode(body));
				} catch {
					// Use the available text estimate when the response has no usable usage.
				}
				const counts = native
					? nativeTokenCounts(
							parsed && typeof parsed === "object" && "usage" in parsed
								? parsed.usage
								: null,
						)
					: null;
				const reported = counts
					? {
							inputTokens: counts.inputTokens,
							outputTokens: counts.outputTokens,
							estimated: false,
						}
					: parseCompletionTokenCounts(parsed);
				const outputCharacters = native
					? nativeOutputCharacters(parsed)
					: completionOutputCharacters(parsed);
				if (reported.inputTokens !== null) {
					inputTokens = reported.inputTokens;
					inputTokensEstimated = Number(
						counts ? counts.inputEstimated : reported.estimated,
					);
				}
				if (
					reported.outputTokens !== null &&
					!(reported.outputTokens === 0 && outputCharacters > 0)
				) {
					outputTokens = reported.outputTokens;
					outputTokensEstimated = Number(
						counts ? counts.outputEstimated : reported.estimated,
					);
				} else {
					outputTokens = estimateTokensFromCharacters(outputCharacters);
				}
			}

			const tokenReservation = await recordUsage(db, {
				platform: model.platform,
				modelId: model.model_id,
				keyId: key.id,
				inputTokens,
				outputTokens,
			});
			await updateKeyHealth(db, key.id, "healthy");
			await resetKeyFailures(db, model.platform, model.model_id, key.id);
			const requestId = await insertRequest(db, {
				user,
				requested,
				modelId: model.model_id,
				platform: model.platform,
				keyId: key.id,
				status: "success",
				statusCode: 200,
				errorMessage: null,
				inputTokens,
				outputTokens,
				inputTokensEstimated,
				outputTokensEstimated,
				latencyMs,
				routingDecision,
				failureAttribution: null,
			});
			if (stream && out.body) {
				out = new Response(
					observeStreamUsage(
						out.body,
						estInputTokens,
						attemptStartedAt,
						async (usage) => {
							if (native)
								await finalizeUsage(
									db,
									tokenReservation,
									usage.inputTokens + (usage.outputTokens ?? 0),
								);
							if (
								native &&
								!usage.completed &&
								!usage.cancelled &&
								!args.signal?.aborted
							) {
								await updateKeyHealth(db, key.id, "error");
								await reportFailure(db, {
									platform: model.platform,
									modelId: model.model_id,
									keyId: key.id,
									source: "server_error",
									reason: "Upstream stream did not complete",
								});
							}
							await db
								.prepare(
									`UPDATE provider_requests
									 SET input_tokens = ?, output_tokens = ?,
									     input_tokens_estimated = ?, output_tokens_estimated = ?,
									     ttft_ms = ?, status = ?, error_message = ?
									 WHERE request_id = ?`,
								)
								.bind(
									usage.inputTokens,
									usage.outputTokens,
									Number(usage.inputTokensEstimated),
									Number(usage.outputTokensEstimated),
									native && !usage.completed ? null : usage.ttftMs,
									native && !usage.completed ? "error" : "success",
									native && !usage.completed
										? "Upstream stream did not complete"
										: null,
									requestId,
								)
								.run();
						},
						native ? "anthropic" : "openai",
					),
					{
						status: out.status,
						statusText: out.statusText,
						headers: out.headers,
					},
				);
			}
			return {
				response: out,
				modelId: model.model_id,
				platform: model.platform,
				keyId: key.id,
				attempts,
			};
		}
	}

	// 3. Exhausted: no upstream accepted the request.
	if (native)
		return {
			response:
				lastNativeError ??
				(throttled
					? anthropicError(
							"Configured key rate limits prevent this request",
							429,
							"rate_limit_error",
						)
					: anthropicError(
							"All compatible configured providers are unavailable",
							502,
							"api_error",
						)),
			modelId: requested,
			platform: "none",
			keyId: 0,
			attempts,
		};
	console.error(
		JSON.stringify({ event: "route_exhausted", model: requested, attempts }),
	);
	const response = new Response(
		JSON.stringify({
			error: {
				message: "All configured upstream providers are unavailable.",
				type: "upstream_error",
				code: "all_providers_failed",
			},
		}),
		{ status: 502, headers: { "Content-Type": "application/json" } },
	);
	return { response, modelId: requested, platform: "none", keyId: 0, attempts };
}

// ---------------------------------------------------------------------------
// Failure path
// ---------------------------------------------------------------------------

async function handleFailure(
	db: D1Database,
	user: AppUser,
	requested: string,
	model: RouterModel,
	key: PlatformKey,
	err: ProviderError,
	start: number,
	decision: {
		strategy: string;
		scores: Record<string, number>;
		alternativesTried: string[];
	},
	platformTallies: Map<string, PlatformTally>,
	persistAttempt = true,
): Promise<void> {
	const source = SOURCE_BY_KIND[err.kind] ?? "server_error";
	const status = err.status;
	// Generic message: no key label, no provider name, no secret material.
	const errorMessage =
		status > 0 ? `Upstream ${status}` : "Upstream request failed";
	const latencyMs = Date.now() - start;

	if (!decision.alternativesTried.includes(model.model_id))
		decision.alternativesTried.push(model.model_id);

	// provider_moment: >=2 distinct keys of the same platform failed with
	// server/timeout within this route (the second such failure is tagged).
	let tally = platformTallies.get(model.platform);
	if (!tally) {
		tally = { serverTimeoutFails: 0, failedKeyIds: new Set<number>() };
		platformTallies.set(model.platform, tally);
	}
	tally.failedKeyIds.add(key.id);
	if (err.kind === "server" || err.kind === "timeout")
		tally.serverTimeoutFails += 1;
	const attribution: Attribution =
		(err.kind === "server" || err.kind === "timeout") &&
		tally.serverTimeoutFails >= 2 &&
		tally.failedKeyIds.size >= 2
			? "provider_moment"
			: source === "rate_limit" ||
					source === "payment" ||
					source === "auth_error"
				? "key_exhausted"
				: "model_error";

	await reportFailure(db, {
		platform: model.platform,
		modelId: model.model_id,
		keyId: key.id,
		source,
		reason: errorMessage,
		retryAfterMs: err.retryAfterMs,
	});
	await updateKeyHealth(db, key.id, HEALTH_BY_KIND[err.kind] ?? "error");
	if (!persistAttempt) return;
	await insertRequest(db, {
		user,
		requested,
		modelId: model.model_id,
		platform: model.platform,
		keyId: key.id,
		status:
			err.kind === "timeout"
				? "timeout"
				: status === 429
					? "rate_limited"
					: "error",
		statusCode: status > 0 ? status : null,
		errorMessage,
		inputTokens: null,
		outputTokens: null,
		inputTokensEstimated: null,
		outputTokensEstimated: null,
		latencyMs,
		routingDecision: decision,
		failureAttribution: attribution,
	});
}
