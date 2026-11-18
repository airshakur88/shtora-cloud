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
import { routeChatCompletion } from "./router";

export async function handleNativeMessages(
	request: Request,
	operation: NativeMessagesRequest["operation"],
): Promise<Response> {
	try {
		const db = getDb();
		const user = await getInferenceUser(request, db, true);
		const native = parseNativeMessages(
			await readInferenceJson(request),
			request.headers,
			operation,
		);
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
