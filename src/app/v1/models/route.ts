import { updateAccessKeyLastUsed, validateAccessKey } from "@/lib/access-keys";
import { nativeModels } from "@/lib/anthropic-models";
import { getDb, getEncryptionSecret } from "@/lib/env";
import {
	buildModelList,
	type ModelListEntry,
	openAiError,
	openAiMethodNotAllowed,
	optionsResponse,
	parseModelsPagination,
} from "@/lib/v1-http";

function unauthorized(): Response {
	return openAiError("Missing or invalid API key", "authentication_error", 401);
}

// OpenAI entry shape: `created: 0` and no permission/root/parent, unlike
// /api/v1/models. Kept as-is for contract compatibility; see v1-http.ts.
interface ModelEntry {
	id: string;
	object: string;
	created: number;
	owned_by: string;
	name: string;
	description?: string;
	providers: string[];
	members?: string[];
}

function toModelEntry(entry: ModelListEntry): ModelEntry {
	return {
		id: entry.id,
		object: "model",
		created: 0,
		owned_by: "shtora",
		name: entry.name,
		...(entry.description !== undefined
			? { description: entry.description }
			: {}),
		providers: entry.providers,
		...(entry.members !== undefined ? { members: entry.members } : {}),
	};
}

export async function GET(request: Request): Promise<Response> {
	// Anthropic branch: any request carrying `anthropic-version` or
	// `x-api-key` gets the native model list (its own scope and cursor
	// pagination), even with a Bearer token. Intentional, not unified.
	if (
		request.headers.has("anthropic-version") ||
		request.headers.has("x-api-key")
	)
		return nativeModels(request);
	try {
		const db = getDb();
		const authorization = request.headers.get("authorization");
		if (!authorization?.startsWith("Bearer ")) return unauthorized();
		const token = authorization.slice(7).trim();
		if (!token) return unauthorized();
		getEncryptionSecret();
		if (!token.startsWith("ska-")) {
			console.warn({
				event: "v1_auth_failed",
				reason: "not_an_api_key",
				length: token.length,
			});
			return unauthorized();
		}
		const record = await validateAccessKey(db, token);
		if (!record) {
			console.warn({ event: "v1_auth_failed", reason: "invalid_api_key" });
			return unauthorized();
		}
		await updateAccessKeyLastUsed(db, record.id);
		const { limit, offset } = parseModelsPagination(
			new URL(request.url).searchParams,
		);
		const page = await buildModelList(db, limit, offset);
		return Response.json({
			object: "list",
			data: page.entries.map(toModelEntry),
			has_more: page.hasMore,
		});
	} catch {
		return openAiError("Internal error", "server_error", 500);
	}
}

export function POST(): Response {
	return openAiMethodNotAllowed("GET", "GET, HEAD, OPTIONS");
}

export function PUT(): Response {
	return openAiMethodNotAllowed("GET", "GET, HEAD, OPTIONS");
}

export function PATCH(): Response {
	return openAiMethodNotAllowed("GET", "GET, HEAD, OPTIONS");
}

export function DELETE(): Response {
	return openAiMethodNotAllowed("GET", "GET, HEAD, OPTIONS");
}

export function OPTIONS(): Response {
	return optionsResponse("GET, HEAD, OPTIONS");
}
