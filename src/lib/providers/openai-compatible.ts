import { KEYLESS_API_KEY } from "../provider-catalog";
import type { ProviderCatalog } from "../types";
import { ProviderError, toProviderError } from "./errors";
import { transformSseStream } from "./sse";
import type { UpstreamChatInput } from "./types";

const ELECTRONHUB_PROXY_ERROR = "### **Proxy error (HTTP ";

function sanitizeCohereSchema(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sanitizeCohereSchema);
	if (!value || typeof value !== "object") return value;
	const result: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (key === "$schema" || key === "additionalProperties") continue;
		result[key] = sanitizeCohereSchema(child);
	}
	return result;
}

function requestModel(
	provider: ProviderCatalog | undefined,
	modelId: string,
): string {
	return provider?.modelAliases?.[modelId] ?? modelId;
}

function validReturnedModel(
	provider: ProviderCatalog,
	requested: string,
	returned: unknown,
): boolean {
	if (typeof returned !== "string" || returned.length === 0) return false;
	switch (provider.modelIdentity) {
		case "exact":
			return returned === requested;
		case "clod": {
			const normalize = (model: string) =>
				model
					.split("/")
					.at(-1)
					?.toLowerCase()
					.replace(/[\s._-]/g, "") ?? "";
			return normalize(returned) === normalize(requested);
		}
		case "dreamprompting": {
			if (requested === "auto") return true;
			const withoutFreeSuffix = requested.replace(/:free$/, "");
			const unprefixed = withoutFreeSuffix.includes("/")
				? withoutFreeSuffix.slice(withoutFreeSuffix.indexOf("/") + 1)
				: withoutFreeSuffix;
			return [requested, withoutFreeSuffix, unprefixed].includes(returned);
		}
		case "simplellm":
			return (
				returned === requested ||
				provider.modelAliases?.[requested] === returned
			);
		default:
			return true;
	}
}

function checkModel(
	provider: ProviderCatalog | undefined,
	requested: string,
	returned: unknown,
): void {
	if (
		provider?.modelIdentity &&
		!validReturnedModel(provider, requested, returned)
	) {
		throw new ProviderError(
			"Upstream returned an unexpected model",
			502,
			"model_mismatch",
		);
	}
}

async function validateJsonResponse(
	response: Response,
	provider: ProviderCatalog | undefined,
	modelId: string,
): Promise<Response> {
	if (!response.ok) throw await toProviderError(response);
	if (!provider?.modelIdentity && !provider?.electronHubProxyError)
		return response;
	let payload: Record<string, unknown>;
	try {
		payload = (await response.clone().json()) as Record<string, unknown>;
	} catch {
		throw new ProviderError(
			"Upstream returned an invalid response",
			502,
			"server",
		);
	}
	checkModel(provider, modelId, payload.model);
	if (provider.electronHubProxyError) {
		const choices = Array.isArray(payload.choices) ? payload.choices : [];
		for (const choice of choices) {
			if (!choice || typeof choice !== "object") continue;
			const message = (choice as Record<string, unknown>).message;
			if (!message || typeof message !== "object") continue;
			const content = (message as Record<string, unknown>).content;
			if (
				typeof content === "string" &&
				content.trimStart().startsWith(ELECTRONHUB_PROXY_ERROR)
			) {
				throw new ProviderError("Upstream proxy failed", 502, "server");
			}
		}
	}
	return response;
}
async function inspectElectronHubStream(response: Response): Promise<Response> {
	if (!response.body) return response;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const buffered: Uint8Array[] = [];
	let lineBuffer = "";
	let contentPrefix = "";
	let byteCount = 0;
	let eventCount = 0;
	let endOfStream = false;
	let passedPrefixCheck = false;

	const inspectLine = (line: string): boolean => {
		if (!line.startsWith("data:")) return false;
		const data = line.slice(5).trim();
		if (!data || data === "[DONE]") return false;
		let payload: Record<string, unknown>;
		try {
			payload = JSON.parse(data) as Record<string, unknown>;
		} catch {
			return false;
		}
		const choices = Array.isArray(payload.choices) ? payload.choices : [];
		for (const choice of choices) {
			if (!choice || typeof choice !== "object") continue;
			const delta = (choice as Record<string, unknown>).delta;
			const content =
				delta && typeof delta === "object"
					? (delta as Record<string, unknown>).content
					: undefined;
			if (typeof content !== "string") continue;
			contentPrefix += content;
			const trimmed = contentPrefix.trimStart();
			if (trimmed.startsWith(ELECTRONHUB_PROXY_ERROR)) {
				throw new ProviderError("Upstream proxy failed", 502, "server");
			}
			if (
				contentPrefix.length >= 256 ||
				(trimmed.length > 0 && !ELECTRONHUB_PROXY_ERROR.startsWith(trimmed))
			)
				return true;
		}
		return false;
	};

	try {
		while (!passedPrefixCheck) {
			const { done, value } = await reader.read();
			if (done) {
				endOfStream = true;
				lineBuffer += decoder.decode();
				if (lineBuffer) inspectLine(lineBuffer.replace(/\r$/, ""));
				break;
			}
			buffered.push(value);
			byteCount += value.byteLength;
			lineBuffer += decoder.decode(value, { stream: true });
			for (;;) {
				const newline = lineBuffer.indexOf("\n");
				if (newline < 0) break;
				const line = lineBuffer.slice(0, newline).replace(/\r$/, "");
				lineBuffer = lineBuffer.slice(newline + 1);
				if (inspectLine(line)) passedPrefixCheck = true;
				eventCount += 1;
				if (passedPrefixCheck) break;
			}
			if (byteCount >= 16_384 || eventCount >= 64) passedPrefixCheck = true;
		}
	} catch (error) {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
		throw error;
	}

	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			void (async () => {
				try {
					for (const chunk of buffered) controller.enqueue(chunk);
					if (endOfStream) {
						controller.close();
						return;
					}
					while (true) {
						const { done, value } = await reader.read();
						if (done) {
							controller.close();
							return;
						}
						controller.enqueue(value);
					}
				} catch (error) {
					controller.error(error);
				} finally {
					reader.releaseLock();
				}
			})();
		},
		async cancel(reason) {
			try {
				await reader.cancel(reason);
			} finally {
				reader.releaseLock();
			}
		},
	});
	return new Response(body, {
		status: response.status,
		headers: response.headers,
	});
}

function validateStreamResponse(
	response: Response,
	provider: ProviderCatalog | undefined,
	modelId: string,
): Response {
	if (!response.body || (!provider?.modelIdentity && !provider?.ensureDone))
		return response;
	const encoder = new TextEncoder();
	let sawDone = false;
	const body = transformSseStream(
		response.body,
		(event, controller) => {
			if (event.data === "[DONE]") sawDone = true;
			if (event.data && event.data !== "[DONE]") {
				try {
					const payload = JSON.parse(event.data) as Record<string, unknown>;
					if (payload.model !== undefined)
						checkModel(provider, modelId, payload.model);
				} catch (error) {
					if (error instanceof ProviderError) throw error;
				}
			}
			const eventPrefix = event.event ? `event: ${event.event}\n` : "";
			const dataLines = event.data
				.split("\n")
				.map((line) => `data: ${line}\n`)
				.join("");
			controller.enqueue(encoder.encode(`${eventPrefix}${dataLines}\n`));
		},
		(controller) => {
			if (provider?.ensureDone && !sawDone) {
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			}
		},
	);
	const headers = new Headers(response.headers);
	headers.delete("content-length");
	return new Response(body, {
		status: response.status,
		headers,
	});
}

export async function sendOpenAICompatible(
	input: UpstreamChatInput,
	provider: ProviderCatalog | undefined,
	baseUrl: string,
	signal?: AbortSignal,
): Promise<Response> {
	const body: Record<string, unknown> = {
		model: requestModel(provider, input.modelId),
		messages: input.messages,
		stream: input.stream,
	};
	if (input.temperature !== undefined) body.temperature = input.temperature;
	if (input.maxTokens !== undefined) body.max_tokens = input.maxTokens;
	if (input.toolChoice !== undefined) body.tool_choice = input.toolChoice;
	if (input.parallelToolCalls !== undefined)
		body.parallel_tool_calls = input.parallelToolCalls;
	if (input.stop !== undefined) {
		body.stop =
			provider?.modelIdentity === "simplellm" && typeof input.stop === "string"
				? [input.stop]
				: input.stop;
	}
	if (input.tools?.length) {
		body.tools =
			provider?.protocol === "cohere_compat"
				? sanitizeCohereSchema(input.tools)
				: input.tools;
		if (provider?.forceSingleToolCall) body.parallel_tool_calls = false;
	}

	const headers = new Headers({ "Content-Type": "application/json" });
	if (!provider?.keyless || input.apiKey !== KEYLESS_API_KEY) {
		headers.set("Authorization", `Bearer ${input.apiKey}`);
	}
	for (const [name, value] of Object.entries(provider?.extraHeaders ?? {})) {
		headers.set(name, value);
	}

	const response = await fetch(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		redirect: "manual",
		signal,
	});
	if (!response.ok) throw await toProviderError(response);
	if (input.stream) {
		const streamResponse = provider?.electronHubProxyError
			? await inspectElectronHubStream(response)
			: response;
		return validateStreamResponse(streamResponse, provider, input.modelId);
	}
	return validateJsonResponse(response, provider, input.modelId);
}
