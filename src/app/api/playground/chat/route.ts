import { routeError } from "@/lib/api-error";
import { parseChatCompletionRequest } from "@/lib/chat-request";
import { getDb, getEncryptionSecret } from "@/lib/env";
import { resolvePlaygroundImages } from "@/lib/playground-images";
import { getSession } from "@/lib/playground-sessions";
import type { RouteResult } from "@/lib/router";
import { routeChatCompletion } from "@/lib/router";
import { requireUser } from "@/lib/session";
import type { ChatContent, ChatMessage, ChatRole } from "@/lib/types";

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

		const modelId =
			typeof bodyObj.modelId === "string" && bodyObj.modelId.trim().length > 0
				? bodyObj.modelId.trim()
				: session.modelId;

		const parsed = parseChatCompletionRequest({
			model: modelId,
			messages: await resolvePlaygroundImages(messages),
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

		const bodyStream = resp.body;
		if (!bodyStream) {
			return Response.json(
				{ error: { message: "Empty response", type: "server_error" } },
				{ status: 500 },
			);
		}

		const reader = bodyStream.getReader();
		const stream = new ReadableStream({
			async pull(controller) {
				try {
					const { value, done } = await reader.read();
					if (done) {
						controller.close();
						return;
					}
					controller.enqueue(value);
				} catch (err) {
					controller.error(err);
				}
			},
			cancel() {
				reader.cancel();
			},
		});

		return new Response(stream, {
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
