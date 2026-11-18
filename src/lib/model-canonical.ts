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
	// Strip pricing/route suffixes such as ":free" or ":paid".
	value = value.split(":")[0];
	// Strip a single leading vendor/provider prefix ("openai/gpt-oss-20b").
	if (value.includes("/")) {
		const firstSlash = value.indexOf("/");
		const rest = value.slice(firstSlash + 1);
		// Only treat it as a prefix when something meaningful remains.
		if (rest.length > 0 && !rest.includes("/")) value = rest;
	}
	value = value.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
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
