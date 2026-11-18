import { routeError } from "@/lib/api-error";
import { parseChatCompletionRequest } from "@/lib/chat-request";
import { getDb, getEncryptionSecret } from "@/lib/env";
import {
	PlaygroundImageError,
	resolvePlaygroundImages,
} from "@/lib/playground-images";
import {
	DEFAULT_SESSION_NAME,
	deriveSessionTitle,
	getSession,
	updateSession,
} from "@/lib/playground-sessions";
import type { RouteResult } from "@/lib/router";
import { routeChatCompletion } from "@/lib/router";
import { requireUser } from "@/lib/session";
import type { ChatContent, ChatMessage, ChatRole } from "@/lib/types";

/** Plain text of a chat message (multimodal parts other than text ignored). */
function messageText(content: ChatContent): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content))
		return content
			.filter(
				(part): part is { type: "text"; text: string } =>
					typeof part === "object" &&
					part !== null &&
					"type" in part &&
					part.type === "text" &&
					"text" in part &&
					typeof part.text === "string",
			)
			.map((part) => part.text)
			.join("\n");
	return "";
}

const VALID_ROLES: Record<ChatRole, true> = {
	system: true,
	user: true,
	assistant: true,
	tool: true,
};

export async function POST(request: Request): Promise<Response> {
	try {
		const user = await requireUser(request);
		const db = getDb();

		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return Response.json(
				{ error: { message: "Invalid request", type: "validation_error" } },
				{ status: 400 },
			);
		}
		const bodyObj = (body ?? {}) as Record<string, unknown>;

		const sessionId =
			typeof bodyObj.sessionId === "string" ? bodyObj.sessionId.trim() : null;
		const messagesRaw = bodyObj.messages;
		if (!sessionId || !Array.isArray(messagesRaw)) {
			return Response.json(
				{
					error: {
						message: "sessionId and messages are required",
						type: "validation_error",
					},
				},
				{ status: 400 },
			);
		}

		// Validate each PlaygroundMessage has role + content
		const messages: ChatMessage[] = [];
		for (const msg of messagesRaw) {
			if (!msg || typeof msg !== "object") continue;
			const item = msg as Record<string, unknown>;
			const role = item.role;
			if (typeof role !== "string" || !VALID_ROLES[role as ChatRole]) {
				continue;
			}
			const content = item.content;
			if (
				typeof content !== "string" &&
				!Array.isArray(content) &&
				content !== null
			) {
				continue;
			}
			messages.push({
				role: role as ChatRole,
				content: content as ChatContent,
			});
		}
		if (messages.length === 0) {
			return Response.json(
				{
					error: {
						message: "No valid messages provided",
						type: "validation_error",
					},
				},
				{ status: 400 },
			);
		}

		const session = await getSession(db, sessionId, user.id);
		if (!session) {
			return Response.json(
				{ error: { message: "Session not found", type: "not_found" } },
				{ status: 404 },
			);
		}

		// Title the session from its first user message, server-side so it
		// holds no matter which client sent it. Only the default name is
		// replaced — a session the user renamed keeps its name.
		if (session.name === DEFAULT_SESSION_NAME) {
			const firstUser = messages.find((msg) => msg.role === "user");
			const title = firstUser
				? deriveSessionTitle(messageText(firstUser.content))
				: null;
			if (title) await updateSession(db, sessionId, user.id, { name: title });
		}

		const modelId =
			typeof bodyObj.modelId === "string" && bodyObj.modelId.trim().length > 0
				? bodyObj.modelId.trim()
				: session.modelId;

		let resolvedMessages: typeof messages;
		try {
			resolvedMessages = await resolvePlaygroundImages(messages);
		} catch (err) {
			if (err instanceof PlaygroundImageError) {
				return Response.json(
					{
						error: {
							message:
								"One or more images could not be loaded. They may have expired or been deleted.",
							type: "validation_error",
						},
					},
					{ status: 422 },
				);
			}
			throw err;
		}

		const parsed = parseChatCompletionRequest({
			model: modelId,
			messages: resolvedMessages,
			stream: true,
		});
		if (!parsed) {
			return Response.json(
				{
					error: {
						message: "Invalid request body",
						type: "validation_error",
					},
				},
				{ status: 400 },
			);
		}

		let result: RouteResult;
		try {
			result = await routeChatCompletion({
				db,
				secret: getEncryptionSecret(),
				user,
				request: parsed,
			});
		} catch (err) {
			console.error(
				JSON.stringify({
					event: "route_error",
					path: "/api/playground/chat",
					error: String(err),
				}),
			);
			return Response.json(
				{ error: { message: "Upstream error", type: "upstream_error" } },
				{ status: 502 },
			);
		}

		const resp = result.response;
		const contentType = resp.headers.get("content-type") ?? "";
		const isStream = contentType.includes("text/event-stream");

		if (!isStream) {
			const json = await resp.text();
			return Response.json(JSON.parse(json), {
				headers: { "Cache-Control": "private, no-store" },
			});
		}

		if (!resp.body) {
			return Response.json(
				{ error: { message: "Empty response", type: "server_error" } },
				{ status: 500 },
			);
		}

		return new Response(resp.body, {
			headers: {
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "private, no-store",
				Connection: "keep-alive",
			},
		});
	} catch (error) {
		return routeError(error, "/api/playground/chat");
	}
}
