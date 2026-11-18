import {
	type NativeMessagesRequest,
	parseNativeMessages,
} from "./anthropic-request";
import { getDb, getEncryptionSecret } from "./env";
import {
	anthropicError,
	getInferenceUser,
	InferenceHttpError,
	readInferenceJson,
} from "./inference-http";
import { listProviders } from "./provider-catalog";
import { routeChatCompletion } from "./router";
import {
	enforceInvalidTokenLimit,
	enforcePublicInferenceLimit,
} from "./v1-http";

export async function handleNativeMessages(
	request: Request,
	operation: NativeMessagesRequest["operation"],
): Promise<Response> {
	try {
		const db = getDb();
		let user: Awaited<ReturnType<typeof getInferenceUser>>;
		try {
			user = await getInferenceUser(request, db, true);
		} catch (error) {
			// Invalid-token attempts are capped per IP (A2): once the
			// budget is gone the probe answers 429, not 401.
			if (error instanceof InferenceHttpError && error.status === 401) {
				const limited = await enforceInvalidTokenLimit(db, request, true);
				if (limited) return limited;
			}
			throw error;
		}
		// Per-token + per-IP cap, before any routing: a capped token never
		// reaches the shared pool (A2).
		const limited = await enforcePublicInferenceLimit(
			db,
			request,
			user.id,
			true,
		);
		if (limited) return limited;
		const native = parseNativeMessages(
			await readInferenceJson(request),
			request.headers,
			operation,
		);
		// The OpenAI-shaped fallback has messages: [] because a request that
		// cannot be translated has no OpenAI representation. It must never
		// be sent upstream as an empty conversation: the direct path posts
		// native.body as-is (sendNativeMessages) and the translated path
		// requires translated !== null (canTranslateNative). For
		// count_tokens, translated is null by design and the router counts
		// from native.body, so this guard only applies to messages.
		//
		// Reject here when no direct (`anthropic_messages`) provider exists
		// to serve the native body — then the router could only answer 400
		// anyway. When one exists, pass through and let the router decide:
		// bound content and opaque native options are served natively,
		// never via this fallback.
		if (operation === "messages" && native.translated === null) {
			const providers = await listProviders(db);
			if (
				!providers.some(
					(provider) => provider.protocol === "anthropic_messages",
				)
			) {
				return anthropicError(
					"Request cannot be translated to the chat format: remove unsupported options or content, or use a model served by a native Anthropic provider",
					400,
					"invalid_request_error",
				);
			}
		}
		const fallback = {
			model: native.body.model,
			messages: [],
			stream: operation === "messages" && native.body.stream === true,
			max_tokens:
				typeof native.body.max_tokens === "number" ? native.body.max_tokens : 0,
		};
		const result = await routeChatCompletion({
			db,
			secret: getEncryptionSecret(),
			user,
			request: native.translated ?? fallback,
			native,
			signal: request.signal,
		});
		if (!result.response.headers.has("request-id"))
			result.response.headers.set("request-id", `req_${crypto.randomUUID()}`);
		return result.response;
	} catch (error) {
		if (error instanceof InferenceHttpError)
			return anthropicError(error.message, error.status, error.type);
		console.error(
			JSON.stringify({ event: "native_messages_error", operation }),
		);
		return anthropicError("Internal error", 500, "api_error");
	}
}
