/**
 * Canonical logical model id.
 *
 * The same model is often published by several upstream providers under
 * slightly different ids (vendor prefix, `:free`/`:paid` suffix, different
 * separators). The router groups them so a single `shtora/<model>` request
 * fans out across every provider that exposes that logical model.
 */
export function canonicalModelId(modelId: string): string {
	let value = modelId.toLowerCase().trim();
	// Strip a trailing pricing suffix (":free", ":paid") only. Other
	// colon suffixes are real variants, not pricing tiers: ":fp8",
	// ":fp4" and ":turbo" must survive, or "deepseek-v4-flash:fp8"
	// (inferbase) merges into "deepseek-v4-flash" (electronhub) and
	// shtora/deepseek-v4-flash can silently serve the FP8 variant.
	if (value.endsWith(":free") || value.endsWith(":paid")) {
		value = value.slice(0, value.lastIndexOf(":"));
	}
	// Strip a single leading vendor/provider prefix ("openai/gpt-oss-20b").
	if (value.includes("/")) {
		const firstSlash = value.indexOf("/");
		const rest = value.slice(firstSlash + 1);
		// Only treat it as a prefix when something meaningful remains.
		if (rest.length > 0 && !rest.includes("/")) value = rest;
	}
	// Strip a leading "free" segment ("free/glm-5.3-flash", "free-glm-5.3-flash").
	// A trailing "-free" is NOT stripped: "qwen3.8-27b-free" is a distinct
	// variant of the model, not the free tier of "qwen3.8-27b".
	while (value.startsWith("free/") || value.startsWith("free-")) {
		value = value.slice(5);
	}
	value = value.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	// The bare canonical "free" is the Kilo free router: it comes only from
	// kilo-auto/free ("Kilo Auto Free") and openrouter/free ("Free Router
	// (Kilo)"), both platform=kilo. It is published as shtora/kilo-free.
	if (value === "free") return "kilo-free";
	return value;
}

/** Prefix used by public endpoints to request router-orchestrated routing. */
export const ROUTER_MODEL_PREFIX = "shtora/";

/** True when the requested model targets the router namespace. */
export function isRouterModel(requested: string): boolean {
	return requested.toLowerCase().startsWith(ROUTER_MODEL_PREFIX);
}

/** Strip the router prefix, returning the bare logical model name. */
export function stripRouterPrefix(requested: string): string {
	return requested.slice(ROUTER_MODEL_PREFIX.length);
}

/**
 * Canonical model ids that must never be listed as ordinary models.
 * "auto" is a curated virtual router (see ./virtual-routers), not an
 * upstream model — the upstream "auto" rows are router rows of other
 * providers, not members of it.
 */
export const EXCLUDED_CANONICAL_MODELS: ReadonlySet<string> = new Set(["auto"]);

/**
 * Short provider aliases used as "(X)" markers in upstream display names.
 * They identify the provider regardless of which row carries them: "(CF)"
 * marks a Cloudflare model even on a row served by another provider
 * (e.g. DreamPrompting re-serving a Cloudflare model).
 */
const PROVIDER_ALIASES: ReadonlySet<string> = new Set(["cf", "nv"]);

/** Upstream "(free…)" markers: the free tier of a provider's router row, not part of the model name. */
const FREE_MARKERS: ReadonlySet<string> = new Set([
	"free",
	"freerouter",
	"freeslow",
]);

function normalizeNameToken(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Strip a trailing " (provider)" from an upstream display name.
 *
 * The catalog mirrors FreeLLMAPI, whose display names usually end with the
 * provider in parentheses ("Cydonia 24B v4.3 (AI Horde)"). The provider
 * already has its own column in the dashboard, so the name shown to the user
 * is just the model name. Only a parenthetical that identifies the provider
 * is removed: the provider id, its display name, a known alias ("CF", "NV"),
 * or a "free" marker ("(free)", "(free router)", "(Routeway free)").
 * Parentheticals that carry model info are kept: quantization ("(FP4)"),
 * variant ("(OVH safety)") and version dates ("(08-2025)").
 */
export function displayModelName(
	name: string,
	providerId: string,
	providerName?: string,
): string {
	const match = name.match(/^(.*) \(([^)]+)\)$/);
	if (!match) return name;
	const [, base, suffix] = match;
	const suffixNorm = normalizeNameToken(suffix);
	const providerNorms = new Set([
		normalizeNameToken(providerId),
		...(providerName ? [normalizeNameToken(providerName)] : []),
	]);
	if (providerNorms.has(suffixNorm) || PROVIDER_ALIASES.has(suffixNorm))
		return base;
	if (FREE_MARKERS.has(suffixNorm)) return base;
	if (
		suffixNorm.endsWith("free") &&
		providerNorms.has(suffixNorm.slice(0, -"free".length))
	)
		return base;
	return name;
}

/**
 * Label shown in the playground model combobox: the display name without a
 * trailing version date such as " (08-2024)". The date only distinguishes
 * versions of the same model in the catalog; the combobox shows the name
 * alone, and the selection value (the model id) still disambiguates.
 */
export function comboboxModelLabel(name: string): string {
	return name.replace(/\s*\(\d{2}-\d{4}\)$/, "");
}

/**
 * Short context window for the models table: 1048576 becomes "1M",
 * 262144 becomes "262K", 4096 becomes "4K". Whole units only, no
 * decimals: the catalog stores raw token counts, so the label is the
 * largest whole unit the count reaches. Zero or missing means the
 * catalog has no window for the model.
 */
export function formatContextWindow(tokens: number | null | undefined): string {
	if (!tokens) return "—";
	if (tokens >= 1_000_000) return `${Math.floor(tokens / 1_000_000)}M`;
	if (tokens >= 1_000) return `${Math.floor(tokens / 1_000)}K`;
	return String(tokens);
}
