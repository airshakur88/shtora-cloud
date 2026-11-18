import type { D1Database, ProviderCatalog } from "./types";

/**
 * Provider runtime config, backed by the D1 `providers` table (migration
 * 0010) — the JSON catalog is gone. Every lookup takes an explicit D1 handle
 * when the caller has one (routes, router, tests); when omitted, the binding
 * is resolved lazily from the Workers env so plain `bun test` (which cannot
 * resolve `cloudflare:workers`) never pays for the import.
 */

export const KEYLESS_API_KEY = "no-key";

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
	if (typeof rawKey === "string" && rawKey.trim().length > 0) return rawKey;
	const isKeyless = keyless ?? (await getProviderConfig(platform, db))?.keyless;
	return isKeyless ? KEYLESS_API_KEY : null;
}
