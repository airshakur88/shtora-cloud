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
import { listProviders } from "./provider-catalog";
import {
	type FailureKind,
	ProviderError,
	sendChat,
	sendNativeMessages,
} from "./providers";
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
	estimatePromptTokens,
	estimateTokensFromCharacters,
	isValidTokenCount,
	parseCompletionTokenCounts,
} from "./token-estimates";
import type {
	AppUser,
	ChatCompletionRequest,
	D1Database,
	ProviderCatalog,
} from "./types";
import {
	getVirtualRouter,
	isVirtualRouter,
	VIRTUAL_ROUTER_FALLBACK_MODELS,
} from "./virtual-routers";

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export interface RouteResult {
	response: Response;
	modelId: string;
	platform: string;
	keyId: number;
	attempts: number;
	/**
	 * One entry per upstream attempt that failed. Kept inside the
	 * RouteResult only: the /v1 routes never serialize it, so provider
	 * names and statuses stay out of public responses. The playground
	 * route attaches it as debug info for the signed-in user.
	 */
	attemptLog?: RouteAttempt[];
}

/** A single failed upstream attempt, for debugging a dead request. */
export interface RouteAttempt {
	platform: string;
	modelId: string;
	status: number;
	kind: FailureKind;
	latencyMs: number;
	phase: "member" | "fallback";
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
// Extra attempts reserved for the virtual-router fallback chain
// (VIRTUAL_ROUTER_FALLBACK_MODELS): one per fallback model. The member
// phase keeps its CHAIN_CAP budget; once it is spent, a virtual router
// request may still try fallback models instead of failing outright.
const FALLBACK_ATTEMPT_CAP = 5;
// Output tokens reserved when the caller sets no max_tokens. The model
// may generate up to 100_000 tokens (chat-request.ts), but reserving
// that for every request would spend the default 200k tpm budget in
// two calls; 8_192 covers a typical completion and the real usage is
// corrected afterwards by stream finalization / the non-stream counts.
const DEFAULT_OUTPUT_TOKENS = 8192;
// Largest non-stream upstream body accepted. A 100k-token completion is
// ~400 KB of text; 10 MB leaves ample room for tool-call JSON while
// bounding the memory one upstream response can consume.
const MAX_NON_STREAM_BODY_BYTES = 10_000_000;
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
		// Virtual routers match by curated membership only: a DB row matches
		// shtora/<router> iff its canonical id is in the router's member
		// list. In particular the upstream "auto" rows (canonical "auto")
		// are NOT members of shtora/auto, so they never match it.
		if (isVirtualRouter(bare)) {
			const router = getVirtualRouter(bare);
			return (
				router?.members.includes(canonicalModelId(model.model_id)) ?? false
			);
		}
		return canonicalModelId(model.model_id) === canonicalModelId(bare);
	}
	return false;
}

/**
 * True when the request names one specific model: a bare canonical id,
 * a `platform/model` id, or `shtora/<model>`. The bare `auto` pool and
 * the virtual routers are not specific: they exist to fan out, so they
 * keep the cross-model chain.
 */
function isSpecificModelRequest(requested: string): boolean {
	if (requested === "auto") return false;
	if (isRouterModel(requested)) {
		return !isVirtualRouter(stripRouterPrefix(requested));
	}
	return true;
}

/** Canonical id -> position in the curated fallback order. */
function fallbackCanonicalIndex(
	fallbackOrder: readonly string[],
): Map<string, number> {
	return new Map(
		fallbackOrder.map((id, index) => [canonicalModelId(id), index]),
	);
}

/**
 * True when a chain row is a fallback row for this request: its
 * canonical id is in the fallback list and it is not already a match.
 * A member row that is also listed as fallback is attempted as a
 * member, under the member budget, never twice.
 */
function isFallbackRow(
	model: RouterModel,
	requested: string,
	fallbackIndex: Map<string, number>,
): boolean {
	if (fallbackIndex.size === 0) return false;
	if (isMatch(model, requested)) return false;
	return fallbackIndex.has(canonicalModelId(model.model_id));
}

/**
 * Matching model first (by model_id or 'platform/model_id'); the rest ordered
 * by tier asc, intelligence_rank asc with NULLS last, id asc.
 *
 * For virtual router requests the curated fallback models sit between
 * the members and the rest, in curated order (not tier/rank order), so
 * a dead member cannot push the fallback out of the chain.
 *
 * The scan window is twice the attempt budget: entries past the attempt
 * budget exist only so the loop can skip keyless models and still reach
 * a keyed one — a tier-1 model with no enabled key must not push a
 * keyed tier-1 model out of the chain. Attempts stay capped at
 * CHAIN_CAP; the extra entries are never attempted, only examined. For
 * virtual routers the window grows by the fallback list, so the
 * fallback models are inside it.
 */
const CHAIN_SCAN = CHAIN_CAP * 2;

function buildChain(
	models: RouterModel[],
	requested: string,
	fallbackOrder: readonly string[] = [],
): RouterModel[] {
	const fallbackIndex = fallbackCanonicalIndex(fallbackOrder);
	return models
		.map((model) => ({
			model,
			key: isMatch(model, requested)
				? 0
				: fallbackIndex.has(canonicalModelId(model.model_id))
					? 1
					: 2,
		}))
		.sort(
			(a, b) =>
				a.key - b.key ||
				(a.key === 1
					? (fallbackIndex.get(canonicalModelId(a.model.model_id)) ?? 0) -
						(fallbackIndex.get(canonicalModelId(b.model.model_id)) ?? 0)
					: 0) ||
				a.model.tier - b.model.tier ||
				(a.model.intelligence_rank === null ? 1 : 0) -
					(b.model.intelligence_rank === null ? 1 : 0) ||
				(a.model.intelligence_rank ?? 0) - (b.model.intelligence_rank ?? 0) ||
				a.model.id - b.model.id,
		)
		.slice(0, CHAIN_SCAN + fallbackOrder.length)
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

/** FNV-1a hash: turns the request identity into a 32-bit PRNG seed. */
function hashSeed(value: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/** Mulberry32: a small seeded PRNG, so the jitter below is reproducible. */
function mulberry32(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Score each chain model from the last 7 days of `provider_requests` with a
 * 2-day half-life. Reliability is per model — the weighted success rate of
 * that model's own rows (0.5 with no data) — aggregated in SQL by model,
 * status and whole-day age bucket, so only a few dozen grouped rows ever
 * reach JS. Speed is 1 - min(1, p50(latency)/5000) per model over a
 * bounded sample of its recent non-null latencies (LIMIT 2000 rows, 0.5
 * with no data); intelligence is 1/(1+(intelligence_rank ?? 10));
 * budget is 1. Each component is sampled as component * (0.8 + 0.4 * u)
 * with u drawn from one PRNG seeded per request (user, model, strategy
 * and prompt), so the same request reproduces the same jitter while a
 * different prompt reshuffles — that uniform jitter IS the Thompson
 * Sampling exploration — and the score is the weighted sum of the
 * samples. The requested model stays pinned at the head of the chain;
 * the rest is re-ordered by score desc (strategy 'priority' keeps chain
 * order). For virtual router requests the curated fallback models stay
 * pinned right after the matches, in curated order, never re-ordered
 * by score.
 */
async function scoreChain(
	db: D1Database,
	chain: RouterModel[],
	strategy: string,
	requested: string,
	seed: number,
	fallbackOrder: readonly string[] = [],
): Promise<{ chain: RouterModel[]; scores: Record<string, number> }> {
	if (strategy === "priority" || chain.length === 0) {
		return {
			chain,
			scores: Object.fromEntries(chain.map((model) => [model.model_id, 1])),
		};
	}
	const weights = STRATEGY_WEIGHTS[strategy] ?? STRATEGY_WEIGHTS.balanced;

	const since = toSqliteDate(Date.now() - 7 * DAY_MS);
	const modelIds = chain.map((model) => model.model_id);
	const placeholders = modelIds.map(() => "?").join(",");
	const buckets = (
		await db
			.prepare(
				`SELECT model_routed AS model_id, status,
				        CAST(julianday('now') - julianday(created_at) AS INTEGER) AS age_days,
				        COUNT(*) AS n
				   FROM provider_requests
				  WHERE created_at > ? AND model_routed IN (${placeholders})
				  GROUP BY model_routed, status, age_days`,
			)
			.bind(since, ...modelIds)
			.all<{
				model_id: string;
				status: string;
				age_days: number | null;
				n: number;
			}>()
	).results;
	const reliabilityByModel = new Map<string, number>();
	{
		const totals = new Map<string, { total: number; success: number }>();
		for (const row of buckets) {
			const age = Math.min(7, Math.max(0, row.age_days ?? 7));
			const weight = 0.5 ** (age / 2) * row.n;
			const entry = totals.get(row.model_id) ?? { total: 0, success: 0 };
			entry.total += weight;
			if (row.status === "success") entry.success += weight;
			totals.set(row.model_id, entry);
		}
		for (const [modelId, entry] of totals) {
			reliabilityByModel.set(
				modelId,
				entry.total > 0 ? entry.success / entry.total : 0.5,
			);
		}
	}
	const latencyRows = (
		await db
			.prepare(
				`SELECT model_routed AS model_id, latency_ms FROM provider_requests
				  WHERE created_at > ? AND latency_ms IS NOT NULL
				    AND model_routed IN (${placeholders})
				  ORDER BY created_at DESC LIMIT 2000`,
			)
			.bind(since, ...modelIds)
			.all<{ model_id: string; latency_ms: number }>()
	).results;
	const latenciesByModel = new Map<string, number[]>();
	for (const row of latencyRows) {
		const list = latenciesByModel.get(row.model_id) ?? [];
		list.push(row.latency_ms);
		latenciesByModel.set(row.model_id, list);
	}

	const random = mulberry32(seed);
	let scored = chain.map((model) => {
		const latencies = latenciesByModel.get(model.model_id) ?? [];
		const speed =
			latencies.length > 0
				? 1 - Math.min(1, percentile50(latencies) / 5000)
				: 0.5;
		const reliability = reliabilityByModel.get(model.model_id) ?? 0.5;
		const intelligence = 1 / (1 + (model.intelligence_rank ?? 10));
		const budget = 1;
		// Uniform jitter in [0.8, 1.2] from the seeded PRNG.
		const sample = (component: number) => component * (0.8 + 0.4 * random());
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
	// reorders the alternatives that follow. For virtual routers the
	// curated fallback models follow the matches in curated order, ahead
	// of the remaining alternatives, so a dead member cannot push the
	// fallback out of the chain.
	const fallbackIndex = fallbackCanonicalIndex(fallbackOrder);
	const matches = scored.filter((entry) => isMatch(entry.model, requested));
	const fallbackEntries = scored
		.filter(
			(entry) =>
				!isMatch(entry.model, requested) &&
				fallbackIndex.has(canonicalModelId(entry.model.model_id)),
		)
		.sort(
			(a, b) =>
				(fallbackIndex.get(canonicalModelId(a.model.model_id)) ?? 0) -
				(fallbackIndex.get(canonicalModelId(b.model.model_id)) ?? 0),
		);
	const rest = scored.filter(
		(entry) =>
			!isMatch(entry.model, requested) &&
			!fallbackIndex.has(canonicalModelId(entry.model.model_id)),
	);
	scored = [...matches, ...fallbackEntries, ...rest];
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
			 (user_id, model_requested, model_routed, platform, key_id,
			  status, status_code, error_message, input_tokens, output_tokens,
			  input_tokens_estimated, output_tokens_estimated, latency_ms,
			  routing_decision, failure_attribution, request_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			p.user.id,
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

interface KeyVerdict {
	key: PlatformKey;
	quarantined: boolean;
	allowed: boolean;
}

/**
 * Quarantine + rate-limit verdicts for every key of one model, checked
 * in parallel: each check touches independent key rows, and checking
 * them one by one costs a round trip per key on every request. The
 * attempt loop below still walks the keys strictly in order and only
 * attempts keys whose verdict allows it; a key that is never reached
 * costs only its verdict queries. Quarantined keys are never
 * rate-checked, exactly as in the sequential loop.
 */
async function verifyModelKeys(
	db: D1Database,
	model: RouterModel,
	keys: PlatformKey[],
	estTokens: number,
): Promise<KeyVerdict[]> {
	const quarantined = await Promise.all(
		keys.map((key) =>
			isKeyQuarantined(db, model.platform, model.model_id, key.id),
		),
	);
	const allowed = await Promise.all(
		keys.map((key, index) =>
			quarantined[index]
				? Promise.resolve(false)
				: canMakeRequest(db, {
						platform: model.platform,
						modelId: model.model_id,
						keyId: key.id,
						estTokens,
						rpmLimit: key.rpmLimit,
						tpmLimit: key.tpmLimit,
						rpdLimit: key.rpdLimit,
						tpdLimit: key.tpdLimit,
					}).then((result) => result.ok),
		),
	);
	return keys.map((key, index) => ({
		key,
		quarantined: quarantined[index],
		allowed: allowed[index],
	}));
}

/**
 * Read a whole non-stream upstream body with a size ceiling. A stream
 * body must never be read here — it would be lost — and an unbounded
 * arrayBuffer lets one upstream allocate without limit in the Worker.
 */
async function readBoundedBody(
	response: Response,
): Promise<Uint8Array<ArrayBuffer>> {
	if (!response.body) return new Uint8Array(0);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_NON_STREAM_BODY_BYTES) {
			await reader.cancel();
			throw new ProviderError("Upstream response too large", 502, "server");
		}
		chunks.push(value);
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

interface ResolvedChain {
	compatibleModels: RouterModel[];
	providerConfigs: Map<string, ProviderCatalog>;
}

/**
 * Stage 1 of routeChatCompletion (M27): load the enabled models and the
 * provider runtime config, filter by the requested capabilities, and
 * answer the client errors that need no upstream attempt — unknown
 * model, or a requested model that cannot serve the requested
 * tools/vision with no compatible alternative. Returns the early
 * Response when the request ends here, otherwise the resolved chain the
 * attempt loop runs. Moved verbatim out of routeChatCompletion so the
 * chain resolution reads on its own; the attempt loop below is untouched.
 */
async function resolveRequestChain(
	db: D1Database,
	request: ChatCompletionRequest,
	native: NativeMessagesRequest | undefined,
): Promise<{ earlyResponse: Response } | { chain: ResolvedChain }> {
	const requested = request.model;
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
	// Provider runtime config (base URL, protocol, ...) comes from the D1
	// `providers` table; loaded once per request and reused by the chain
	// filter and the attempt loop below.
	const providerConfigs = new Map(
		(await listProviders(db)).map((provider) => [provider.id, provider]),
	);
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
				providerConfigs.get(model.platform)?.protocol === "anthropic_messages";
			if (requested !== "auto" && !isMatch(model, requested)) return false;
			if (
				(native.operation === "count_tokens" || native.bound) &&
				requested === "auto"
			)
				return false;
			if (
				!direct &&
				!canTranslateNative(native, providerConfigs.get(model.platform))
			)
				return false;
			if (direct) return true;
		}
		return (
			(!needsTools || model.supports_tools === 1) &&
			(!needsVision || model.supports_vision === 1)
		);
	});
	// A request that names one specific model only ever serves rows of
	// that model: fan-out across the model's providers stays, but a
	// different model is never a substitute. The bare `auto` pool and
	// the virtual routers keep the full compatible chain, so their
	// cross-model failover is untouched. The native filter above already
	// restricts to matching rows for a specific request; this is the
	// same restriction for the OpenAI path.
	const routableModels = isSpecificModelRequest(requested)
		? compatibleModels.filter((model) => isMatch(model, requested))
		: compatibleModels;
	if (native) {
		const selected = models.filter((model) => isMatch(model, requested));
		const response =
			requested !== "auto" && !selected.length
				? anthropicError("Unknown or disabled model", 404, "not_found_error")
				: !routableModels.length
					? anthropicError(
							"Requested model cannot preserve these native content blocks or options; token counting and bound state require an explicit model",
						)
					: null;
		if (response) return { earlyResponse: response };
	}
	if (!native) {
		// The OpenAI path used to answer an unknown model by silently
		// serving the best-ranked models instead. A request that names
		// no enabled model is a client error, not a routing
		// opportunity — answer 404, like the native path already does.
		// The same applies when the requested model exists but none of
		// its rows can serve the requested tools/vision: a compatible
		// different model is not a substitute for a direct request.
		if (!models.some((model) => isMatch(model, requested))) {
			return {
				earlyResponse: Response.json(
					{
						error: {
							message: "Unknown or disabled model",
							type: "invalid_request_error",
							code: "model_not_found",
						},
					},
					{ status: 404 },
				),
			};
		}
		if ((needsTools || needsVision) && routableModels.length === 0) {
			return {
				earlyResponse: Response.json(
					{
						error: {
							message:
								"Requested model does not support the requested features",
							type: "invalid_request_error",
							code: null,
						},
					},
					{ status: 404 },
				),
			};
		}
	}
	return { chain: { compatibleModels: routableModels, providerConfigs } };
}

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
	const native = args.native;

	// 1. Chain
	const resolved = await resolveRequestChain(db, request, native);
	if ("earlyResponse" in resolved)
		return {
			response: resolved.earlyResponse,
			modelId: requested,
			platform: "",
			keyId: 0,
			attempts: 0,
			attemptLog: [],
		};
	const { compatibleModels, providerConfigs } = resolved.chain;

	// 2. Strategy + Thompson sampling (reorders the chain, except 'priority')
	const settingRow = await db
		.prepare("SELECT value FROM settings WHERE key = 'routing_strategy'")
		.bind()
		.first<{ value: string }>();
	const strategy = settingRow?.value ?? "balanced";
	// Virtual router requests carry the curated fallback chain after
	// their members; direct requests and the bare `auto` pool do not.
	const fallbackOrder =
		isRouterModel(requested) && isVirtualRouter(requested)
			? VIRTUAL_ROUTER_FALLBACK_MODELS
			: [];
	const fallbackIndex = fallbackCanonicalIndex(fallbackOrder);
	const { chain, scores } = await scoreChain(
		db,
		buildChain(compatibleModels, requested, fallbackOrder),
		strategy,
		requested,
		// One jitter sequence per request, seeded from the request
		// itself so the same request reproduces the same order.
		hashSeed(
			[
				user.id,
				requested,
				strategy,
				JSON.stringify(request.messages).slice(0, 4096),
			].join("\n"),
		),
		fallbackOrder,
	);
	// Fair share of the attempt budget per chain model: one model with
	// many keys must not consume all CHAIN_CAP attempts before the
	// other models are tried. Fallback rows share their own smaller
	// budget the same way.
	const maxAttemptsPerModel = Math.max(
		1,
		Math.floor(CHAIN_CAP / Math.max(1, chain.length)),
	);
	const fallbackRowCount = chain.filter((model) =>
		isFallbackRow(model, requested, fallbackIndex),
	).length;
	const maxFallbackAttemptsPerModel = Math.max(
		1,
		Math.floor(FALLBACK_ATTEMPT_CAP / Math.max(1, fallbackRowCount)),
	);
	const attemptsByModel = new Map<string, number>();

	// Total attempts, reported to the caller. The member phase
	// (members + rest) and the fallback phase have separate budgets:
	// memberAttempts is capped at CHAIN_CAP, fallbackAttempts at
	// FALLBACK_ATTEMPT_CAP, so a spent member budget never blocks the
	// fallback rows later in the chain.
	let attempts = 0;
	const attemptLog: RouteAttempt[] = [];
	let memberAttempts = 0;
	let fallbackAttempts = 0;
	const alternativesTried: string[] = [];
	const routingDecision = { strategy, scores, alternativesTried };
	const platformTallies = new Map<string, PlatformTally>();
	let lastNativeError: Response | undefined;
	let throttled = false;

	const estInputTokens = native
		? estimateTokensFromCharacters(native.inputCharacters)
		: estimatePromptTokens(request.messages, request.stop);
	const estTokens =
		estInputTokens + (request.max_tokens ?? DEFAULT_OUTPUT_TOKENS);

	for (const model of chain) {
		if (memberAttempts >= CHAIN_CAP && fallbackAttempts >= FALLBACK_ATTEMPT_CAP)
			break;
		const isFallback = isFallbackRow(model, requested, fallbackIndex);
		// A spent member budget skips member and rest rows without
		// ending the loop, so the fallback rows later in the chain are
		// still reached; a spent fallback budget skips fallback rows.
		if (
			isFallback
				? fallbackAttempts >= FALLBACK_ATTEMPT_CAP
				: memberAttempts >= CHAIN_CAP
		)
			continue;

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
		const verdicts = await verifyModelKeys(db, model, keys, estTokens);

		for (const { key, quarantined, allowed } of verdicts) {
			if (
				isFallback
					? fallbackAttempts >= FALLBACK_ATTEMPT_CAP
					: memberAttempts >= CHAIN_CAP
			)
				break;
			if (
				(attemptsByModel.get(model.model_id) ?? 0) >=
				(isFallback ? maxFallbackAttemptsPerModel : maxAttemptsPerModel)
			)
				break;
			if (quarantined) continue;
			if (!allowed) {
				throttled = true;
				continue;
			}

			attempts += 1;
			if (isFallback) fallbackAttempts += 1;
			else memberAttempts += 1;
			attemptsByModel.set(
				model.model_id,
				(attemptsByModel.get(model.model_id) ?? 0) + 1,
			);
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
					baseUrl: providerConfigs.has(model.platform) ? null : key.baseUrl,
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
					providerConfigs.get(model.platform)?.protocol ===
						"anthropic_messages";
				response = direct
					? await sendNativeMessages(input, native, signal, db)
					: await sendChat(input, signal, db);
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
						attemptLog,
					};
				}
				const providerError =
					err instanceof ProviderError
						? err
						: new ProviderError("Upstream request failed", 0, "network");
				attemptLog.push({
					platform: model.platform,
					modelId: model.model_id,
					status: providerError.status,
					kind: providerError.kind,
					latencyMs: Date.now() - start,
					phase: isFallback ? "fallback" : "member",
				});
				if (native) {
					lastNativeError = providerError.nativeResponse;
					// One failure, one quarantine report: an earlier
					// second call here counted a single bad_request
					// twice against the key.
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
					attemptLog,
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
				const body = await readBoundedBody(response);
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
							// Finalize for both protocols: the OpenAI
							// stream used to keep its estimated input +
							// 0 output forever, so streamed output never
							// counted against the key's tpm budget.
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
				attemptLog,
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
			attemptLog,
		};
	if (throttled)
		return {
			response: new Response(
				JSON.stringify({
					error: {
						message:
							"All configured upstream keys are rate limited. Try again later.",
						type: "rate_limit_error",
						code: "rate_limited",
					},
				}),
				{ status: 429, headers: { "Content-Type": "application/json" } },
			),
			modelId: requested,
			platform: "none",
			keyId: 0,
			attempts,
			attemptLog,
		};
	console.error(
		JSON.stringify({
			event: "route_exhausted",
			model: requested,
			attempts,
			attemptLog,
		}),
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
	return {
		response,
		modelId: requested,
		platform: "none",
		keyId: 0,
		attempts,
		attemptLog,
	};
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
