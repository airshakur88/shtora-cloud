import type { ProviderCatalog } from "../types";
import { ProviderError } from "./errors";
import { transformSseStream } from "./sse";

/**
 * One check for the model id an upstream echoes back, used by every
 * sender and by the router's post-parse check. Before this module the
 * check lived only in the generic sender (openai-compatible.ts):
 * Google and Anthropic rewrote `model` with the requested id during
 * normalization, and Cloudflare, Moondream and AI Horde never checked,
 * so `exact` was dead letter for those platforms.
 *
 * `exact` means the upstream served the model it was asked for, modulo
 * the upstream's own version resolution: Gemini answers an alias
 * request (`gemini-2.0-flash`) with the versioned id in `modelVersion`
 * (`gemini-2.0-flash-001`), and Anthropic answers an undated alias
 * (`claude-sonnet-4-5`) with the dated snapshot
 * (`claude-sonnet-4-5-20250929`). One trailing `-<digits>` segment is
 * therefore stripped before comparing. Anything else — a different
 * family (`-lite`), a different model — still mismatches.
 *
 * `model_identity` NULL (no rule) in the catalog: bai, cerebras,
 * huggingface, ollama, orcarouter, together, xai. None of the seven
 * is activated here — changing `model_identity` needs a catalog
 * migration, and no live probe ran against any of them. Evidence
 * from the vendors' own docs, for a future migration:
 * cerebras, together, xai, ollama — OpenAI-compatible endpoints
 * whose documented responses echo the requested model id, so
 * `exact` is safe to set for them. huggingface — the router
 * requires a `:provider` suffix and now routes through OpenRouter,
 * so the echo may carry the suffix or a routed provider id; do not
 * set `exact` without a live probe. bai, orcarouter — no usable
 * doc evidence for the echo; do not set.
 */

function stripVersionSuffix(model: string): string {
	return model.replace(/-\d+$/, "");
}

function matchesExact(
	requested: string,
	returned: string,
	alias?: string,
): boolean {
	if (returned === requested) return true;
	if (alias !== undefined && returned === alias) return true;
	if (stripVersionSuffix(returned) === requested) return true;
	if (alias !== undefined && stripVersionSuffix(returned) === alias)
		return true;
	return false;
}

function normalize(value: string): string {
	return (
		value
			.split("/")
			.at(-1)
			?.toLowerCase()
			.replace(/[\s._-]/g, "") ?? ""
	);
}

/**
 * True when the echoed model id is the requested one under the
 * provider's `model_identity` rule. A provider without a rule, or an
 * echo that is missing entirely, is not verifiable and passes: an
 * absent `model` field must not fail a request the upstream answered.
 */
export function isValidReturnedModel(
	provider: ProviderCatalog | undefined,
	requested: string,
	returned: unknown,
): boolean {
	if (typeof returned !== "string" || returned.length === 0) return true;
	if (!provider?.modelIdentity) return true;
	const alias = provider.modelAliases?.[requested];
	switch (provider.modelIdentity) {
		case "exact":
			return matchesExact(requested, returned, alias);
		case "clod":
			return normalize(returned) === normalize(requested);
		case "dreamprompting": {
			if (requested === "auto") return true;
			const withoutFreeSuffix = requested.replace(/:free$/, "");
			const unprefixed = withoutFreeSuffix.includes("/")
				? withoutFreeSuffix.slice(withoutFreeSuffix.indexOf("/") + 1)
				: withoutFreeSuffix;
			return [requested, withoutFreeSuffix, unprefixed].includes(returned);
		}
		case "simplellm":
			return returned === requested || alias === returned;
		default:
			return true;
	}
}

export function checkReturnedModel(
	provider: ProviderCatalog | undefined,
	requested: string,
	returned: unknown,
): void {
	if (
		provider?.modelIdentity &&
		!isValidReturnedModel(provider, requested, returned)
	) {
		throw new ProviderError(
			"Upstream returned an unexpected model",
			502,
			"model_mismatch",
		);
	}
}

/**
 * Stream echo check for senders that relay the upstream SSE verbatim
 * (Cloudflare, Moondream): the first event carrying a `model` field
 * is validated, the rest pass through untouched. Events without a
 * model field are unverifiable and pass.
 */
export function validateStreamModelEcho(
	body: ReadableStream<Uint8Array>,
	provider: ProviderCatalog | undefined,
	modelId: string,
): ReadableStream<Uint8Array> {
	if (!provider?.modelIdentity) return body;
	let checked = false;
	return transformSseStream(body, (event, controller) => {
		if (event.data && event.data !== "[DONE]" && !checked) {
			try {
				const payload = JSON.parse(event.data) as Record<string, unknown>;
				if (payload.model !== undefined) {
					checked = true;
					checkReturnedModel(provider, modelId, payload.model);
				}
			} catch (error) {
				if (error instanceof ProviderError) throw error;
			}
		}
		const eventPrefix = event.event ? `event: ${event.event}\n` : "";
		const dataLines = event.data
			.split("\n")
			.map((line) => `data: ${line}\n`)
			.join("");
		controller.enqueue(
			new TextEncoder().encode(`${eventPrefix}${dataLines}\n`),
		);
	});
}
