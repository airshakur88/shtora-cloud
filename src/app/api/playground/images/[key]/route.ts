import { apiErrorResponse } from "@/lib/api-error";
import { getDb, getImagesBucket } from "@/lib/env";
import { requireUser } from "@/lib/session";
import type { AppUser } from "@/lib/types";

/** Same shape as the upload route: extension is derived from the sniffed
 * MIME at upload time, never from client input. */
const MIME_BY_EXTENSION: Record<string, string> = {
	png: "image/png",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
};

function errorResponse(message: string, status: number): Response {
	return apiErrorResponse(message, "not_found", status, {
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
		Vary: "Cookie",
	});
}

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ key: string }> },
): Promise<Response> {
	let user: AppUser;
	try {
		user = await requireUser(request);
	} catch {
		return errorResponse("Not authenticated", 401);
	}

	const { key } = await params;
	if (
		!key ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpeg|webp|gif)$/i.test(
			key,
		)
	) {
		return errorResponse("Invalid image", 400);
	}

	// Ownership check (M3): only the user who uploaded the object may fetch
	// it. A missing row and a row owned by someone else both answer 404, so
	// the response never reveals whether the key exists. Images uploaded
	// before migration 0016 have no row and answer 404.
	const row = await getDb()
		.prepare("SELECT user_id FROM playground_images WHERE key = ?")
		.bind(key)
		.first<{ user_id: string }>();
	if (!row || row.user_id !== user.id)
		return errorResponse("Image not found", 404);

	const bucket = getImagesBucket();
	const object = await bucket.get(key);
	if (!object) return errorResponse("Image not found", 404);

	const extension = key.split(".").pop()?.toLowerCase() ?? "";
	const headers = new Headers();
	headers.set(
		"Content-Type",
		MIME_BY_EXTENSION[extension] ?? "application/octet-stream",
	);
	// Authenticated content: private, so a shared cache never serves one
	// user's image to another. nosniff stops MIME confusion; Vary: Cookie
	// keeps caches from reusing a response across sessions.
	headers.set("Cache-Control", "private, max-age=3600");
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("Vary", "Cookie");
	if (object.size !== undefined)
		headers.set("Content-Length", String(object.size));
	return new Response(object.body, { headers });
}
