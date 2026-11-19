import {
	AccessAuthError,
	authenticateAccessKey,
	createAuthErrorResponse,
} from "@/lib/access-auth";
import { getDb } from "@/lib/env";
import {
	buildModelList,
	type ModelListEntry,
	openAiError,
	openAiMethodNotAllowed,
	optionsResponse,
} from "@/lib/v1-http";

// /api/v1 entry shape: `created` is now and entries carry
// `permission`/`root`/`parent`, unlike /v1. Kept as-is for contract
// compatibility; see v1-http.ts. Scope and listing are shared
// with GET /v1/models (buildModelList).
interface ModelEntry {
	id: string;
	object: string;
	created: number;
	owned_by: string;
	name: string;
	description?: string;
	providers: string[];
	members?: string[];
	permission: unknown[];
	root: string;
	parent: string | null;
}

function toModelEntry(entry: ModelListEntry): ModelEntry {
	return {
		id: entry.id,
		object: "model",
		created: Math.floor(Date.now() / 1000),
		owned_by: "shtora",
		name: entry.name,
		...(entry.description !== undefined
			? { description: entry.description }
			: {}),
		providers: entry.providers,
		...(entry.members !== undefined ? { members: entry.members } : {}),
		permission: [],
		root: entry.id,
		parent: null,
	};
}

export async function GET(request: Request): Promise<Response> {
	try {
		await authenticateAccessKey(request);
	} catch (error) {
		if (error instanceof AccessAuthError) {
			return createAuthErrorResponse(error);
		}
		return openAiError("Authentication failed", "auth_error", 401);
	}

	try {
		const db = getDb();
		const entries = await buildModelList(db);
		return Response.json({
			object: "list",
			data: entries.map(toModelEntry),
			has_more: false,
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
