import { getImagesBucket } from "@/lib/env";
import { requireUser } from "@/lib/session";

function errorResponse(message: string, status: number): Response {
	return Response.json({ error: { message, type: "not_found" } }, { status });
}

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ key: string }> },
): Promise<Response> {
	try {
		await requireUser(request);
	} catch {
		return errorResponse("Not authenticated", 401);
	}

	const { key } = await params;
	if (!key || !/^[0-9a-f-]{8,}\.(png|jpeg|webp|gif)$/i.test(key)) {
		return errorResponse("Invalid image", 400);
	}

	const bucket = getImagesBucket();
	const object = await bucket.get(key);
	if (!object) return errorResponse("Image not found", 404);

	const headers = new Headers();
	headers.set(
		"Content-Type",
		object.httpMetadata?.contentType ?? "application/octet-stream",
	);
	headers.set("Cache-Control", "public, max-age=31536000, immutable");
	return new Response(object.body, { headers });
}
