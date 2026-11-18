/**
 * Curated virtual routers.
 *
 * A virtual router is a public `shtora/<name>` id that is not a single
 * upstream model: it fans out, in priority order, over a curated list of
 * canonical model ids. Membership is the only thing that defines a virtual
 * router — a DB row matches `shtora/<name>` iff its canonical id is in the
 * member list. If a member has no enabled DB row at runtime the router
 * simply skips it; a virtual router with no routable member is never
 * listed and never matches.
 */

import { canonicalModelId, ROUTER_MODEL_PREFIX } from "./model-canonical";

export interface VirtualRouter {
	/** Bare name, used after `shtora/`. */
	id: string;
	/** Short display name. */
	name: string;
	/** One-line description for listings. */
	description: string;
	/** Canonical model ids, in routing priority order. */
	members: readonly string[];
}

export const VIRTUAL_ROUTERS: Record<string, VirtualRouter> = {
	auto: {
		id: "auto",
		name: "Shtora Auto",
		description:
			"Shtora Auto — best overall models, with tool calling and large context",
		members: [
			"qwen3-8-max",
			"qwen3-8-flash",
			"qwen3-8-omni-flash",
			"gpt-5-6-luna",
			"gemini-3-5-flash",
			"minimax-m3",
			"qwen3-7-max",
			"nemotron-3-ultra-550b-a55b",
			"gpt-5-4-mini",
			"qwen3-6-27b",
		],
	},
	coding: {
		id: "coding",
		name: "Shtora Coding",
		description:
			"Shtora Coding — best models for programming, with tool calling",
		members: [
			"qwen3-coder-plus",
			"qwen3-coder-30-a3b-instruct",
			"mistral-code-latest",
			"north-mini-code",
			"codestral-latest",
			"codestral-2508",
			"qwen3-8-max",
			"gemini-3-5-flash",
			"qwen3-8-flash",
		],
	},
	fast: {
		id: "fast",
		name: "Shtora Fast",
		description: "Shtora Fast — flash models for low-latency responses",
		members: [
			"qwen3-8-flash",
			"qwen3-8-flash-next",
			"glm-5-3-flash",
			"deepseek-v4-1-flash",
			"gemini-3-5-flash-lite",
			"gpt-5-4-nano",
			"qwen3-8-omni-flash",
		],
	},
	smart: {
		id: "smart",
		name: "Shtora Smart",
		description:
			"Shtora Smart — highest-intelligence models for hard reasoning",
		members: [
			"qwen3-8-max",
			"glm-5-3-flash",
			"qwen3-8-flash-next",
			"qwen3-8-flash",
			"deepseek-v4-1-flash",
			"qwen3-8-omni-flash",
			"gpt-5-6-luna",
			"deepseek-v4-flash",
			"qwen3-8-27b",
			"glm-5-2",
		],
	},
	vision: {
		id: "vision",
		name: "Shtora Vision",
		description: "Shtora Vision — vision-capable models, with tool calling",
		members: [
			"qwen3-8-flash",
			"qwen3-8-omni-flash",
			"gpt-5-6-luna",
			"gemini-3-5-flash",
			"gpt-5-4-mini",
			"gemini-3-5-flash-lite",
			"muse-glimmer-30b",
			"qwen3-5-omni-plus",
		],
	},
	"3d": {
		id: "3d",
		name: "Shtora 3D",
		description:
			"Shtora 3D — code and vision models for creating and editing 3D scenes",
		members: [
			"gpt-5-4-mini",
			"gpt-5-6-luna",
			"gemini-3-5-flash",
			"qwen3-coder-plus",
			"qwen3-coder-30-a3b-instruct",
			"mistral-code-latest",
			"north-mini-code",
			"codestral-latest",
			"qwen3-8-flash",
			"qwen3-8-omni-flash",
		],
	},
};

export const VIRTUAL_ROUTER_IDS: readonly string[] =
	Object.keys(VIRTUAL_ROUTERS);

/**
 * Curated fallback chain for virtual router requests, best first.
 *
 * When every member of a virtual router fails, the router tries these
 * models before giving up. Each one exists in the catalog with tool
 * calling and vision, and the list spreads across providers
 * (ElectronHub, xKiro, Google, Anthropic) so one provider outage does
 * not kill the fallback. A model that is also a member of the requested
 * router is attempted as a member, never twice as fallback.
 */
export const VIRTUAL_ROUTER_FALLBACK_MODELS: readonly string[] = [
	"gpt-5-4-mini",
	"gpt-5-6-luna",
	"mistral-large-2512",
	"gemini-3-5-flash",
	"claude-sonnet-5-5",
];

/** Normalize a requested bare name (with or without the shtora/ prefix). */
function normalizeBare(bare: string): string {
	let value = bare.toLowerCase().trim();
	if (value.startsWith(ROUTER_MODEL_PREFIX)) {
		value = value.slice(ROUTER_MODEL_PREFIX.length);
	}
	return canonicalModelId(value);
}

export function isVirtualRouter(bare: string): boolean {
	return normalizeBare(bare) in VIRTUAL_ROUTERS;
}

export function getVirtualRouter(bare: string): VirtualRouter | undefined {
	return VIRTUAL_ROUTERS[normalizeBare(bare)];
}

export interface VirtualRouterListing {
	id: string;
	name: string;
	description: string;
	members: string[];
}

/** One listing entry per virtual router, for the public model listings. */
export function listingVirtualRouters(): VirtualRouterListing[] {
	return VIRTUAL_ROUTER_IDS.map((id) => {
		const router = VIRTUAL_ROUTERS[id];
		return {
			id: `${ROUTER_MODEL_PREFIX}${router.id}`,
			name: router.name,
			description: router.description,
			members: [...router.members],
		};
	});
}

/**
 * Union of providers for the members of a virtual router that are present
 * in a listing's source, keyed by canonical model id.
 */
export function virtualRouterProviders(
	members: readonly string[],
	providersByCanonical: Map<string, readonly string[]>,
): string[] {
	const providers: string[] = [];
	for (const member of members) {
		for (const provider of providersByCanonical.get(member) ?? []) {
			if (!providers.includes(provider)) providers.push(provider);
		}
	}
	return providers;
}
