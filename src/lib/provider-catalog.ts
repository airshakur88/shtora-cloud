import type { D1Database, ProviderCatalog } from "./types";

/**
 * Provider runtime config, backed by the D1 `providers` table (migration
 * 0010) — the JSON catalog is gone. Every lookup takes an explicit D1 handle
 * when the caller has one (routes, router, tests); when omitted, the binding
 * is resolved lazily from the Workers env so plain `bun test` (which cannot
 * resolve `cloudflare:workers`) never pays for the import.
 */

export const KEYLESS_API_KEY = "no-key";

/**
 * The only off-catalog platform POST /api/keys accepts. It is the explicit
 * custom-endpoint escape hatch the dashboard form offers (baseUrl field
 * shown only when platform is "custom"); every other off-catalog platform
 * (notably `anthropic` / `openai`) is rejected as unknown. A `custom` key
 * without a baseUrl can never serve, so the route requires one.
 */
export const CUSTOM_PLATFORM = "custom";

/**
 * Expected key prefixes per provider, from the "Key format reference" in
 * AGENTS.md ("key prefixes seen upstream"). This is a plausibility check,
 * not a guarantee: a key that does not start with its provider's documented
 * prefix is rejected as `invalid_key`. Providers absent from this map
 * (groq, google, cohere, ...) have no documented prefix in the reference
 * and are not checked — `sk-` is generic and `AQ.Ab8...` / `email:token` /
 * `id.secret` are patterns, not literal prefixes, so they are left out.
 */
const KEY_PREFIX_BY_PLATFORM: Record<string, string> = {
	aihorda: "ek",
	airforce: "sk-air-",
	bazaarlink: "sk-bl-",
	blaze: "blaze-",
	dreamprompting: "dp-",
	electronhub: "ek",
	firecrawl: "fc-",
	freeai: "sk-free-",
	freetts: "ft_live_",
	huggingface: "hf_",
	inferbase: "inf_",
	iteracompute: "ick_live_",
	kenari: "kn-",
	kiosapi: "kios_live_",
	llmtr: "llmtr-",
	logfare: "lfu_",
	lucidity: "cmp-",
	mistral: "mstrl_",
	nvidia: "nvapi-",
	onomeo: "sk-onomeo-",
	openrouter: "sk-or-v1-",
	orcarouter: "sk-orca-",
	radeon: "rc-",
	router9: "sk-r9k-",
	speka: "sk-speka-live-",
	tavily: "tvly-dev-",
	xkiro: "sk-xt-",
};

export function isPlausibleProviderKey(platform: string, key: string): boolean {
	if (/\s/.test(key)) return false;
	const prefix = KEY_PREFIX_BY_PLATFORM[platform];
	return prefix === undefined || key.startsWith(prefix);
}

const PROVIDER_COLUMNS =
	"id, name, base_url, auth_type, protocol, description, keyless, key_hint, extra_headers, force_single_tool_call, model_identity, model_aliases, electron_hub_proxy_error, ensure_done, limits";

interface ProviderRow {
	id: string;
	name: string;
	base_url: string;
	auth_type: string;
	protocol: string;
	description: string | null;
	keyless: number;
	key_hint: string | null;
	extra_headers: string | null;
	force_single_tool_call: number | null;
	model_identity: string | null;
	model_aliases: string | null;
	electron_hub_proxy_error: number | null;
	ensure_done: number | null;
	limits: string | null;
}

function parseJsonObject(
	value: string | null,
): Record<string, string> | undefined {
	if (!value) return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, string>;
		}
	} catch {
		// Corrupt JSON in a config column: treat as absent, don't crash routing.
	}
	return undefined;
}

function parseLimits(value: string | null) {
	if (!value) return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as ProviderCatalog["limits"];
		}
	} catch {
		// Same as above: absent on corrupt data.
	}
	return undefined;
}

function rowToProvider(row: ProviderRow): ProviderCatalog {
	return {
		id: row.id,
		name: row.name,
		baseUrl: row.base_url,
		authType: row.auth_type as ProviderCatalog["authType"],
		protocol: row.protocol as ProviderCatalog["protocol"],
		description: row.description ?? undefined,
		keyless: row.keyless === 1 ? true : undefined,
		keyHint: row.key_hint ?? undefined,
		extraHeaders: parseJsonObject(row.extra_headers),
		forceSingleToolCall:
			row.force_single_tool_call === null
				? undefined
				: row.force_single_tool_call === 1,
		modelIdentity: (row.model_identity ?? undefined) as
			| ProviderCatalog["modelIdentity"]
			| undefined,
		modelAliases: parseJsonObject(row.model_aliases),
		electronHubProxyError:
			row.electron_hub_proxy_error === null
				? undefined
				: row.electron_hub_proxy_error === 1,
		ensureDone: row.ensure_done === null ? undefined : row.ensure_done === 1,
		limits: parseLimits(row.limits),
	};
}

async function resolveDb(db?: D1Database): Promise<D1Database> {
	if (db) return db;
	try {
		const { getDb } = await import("./env");
		return getDb();
	} catch {
		throw new Error("Database unavailable");
	}
}

export async function listProviders(
	db?: D1Database,
): Promise<ProviderCatalog[]> {
	const database = await resolveDb(db);
	const result = await database
		.prepare(`SELECT ${PROVIDER_COLUMNS} FROM providers ORDER BY id`)
		.all<ProviderRow>();
	return result.results.map(rowToProvider);
}

export async function listProviderIds(
	db?: D1Database,
): Promise<ReadonlySet<string>> {
	const database = await resolveDb(db);
	const result = await database
		.prepare("SELECT id FROM providers ORDER BY id")
		.all<{ id: string }>();
	return new Set(result.results.map((row) => row.id));
}

export async function getProviderConfig(
	platform: string,
	db?: D1Database,
): Promise<ProviderCatalog | undefined> {
	const database = await resolveDb(db);
	const row = await database
		.prepare(`SELECT ${PROVIDER_COLUMNS} FROM providers WHERE id = ?`)
		.bind(platform)
		.first<ProviderRow>();
	return row ? rowToProvider(row) : undefined;
}

export async function isKnownProvider(
	platform: string,
	db?: D1Database,
): Promise<boolean> {
	return (await getProviderConfig(platform, db)) !== undefined;
}

export async function normalizeProviderKey(
	platform: string,
	rawKey: unknown,
	keyless?: boolean,
	db?: D1Database,
): Promise<string | null> {
	if (typeof rawKey === "string" && rawKey.trim().length > 0) {
		const trimmed = rawKey.trim();
		return isPlausibleProviderKey(platform, trimmed) ? trimmed : null;
	}
	const isKeyless = keyless ?? (await getProviderConfig(platform, db))?.keyless;
	return isKeyless ? KEYLESS_API_KEY : null;
}
