import { getImagesBucket } from "@/lib/env";
import { requireUser } from "@/lib/session";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_IMAGES = 10;
const ALLOWED_MIME: Record<string, true> = {
	"image/png": true,
	"image/jpeg": true,
	"image/webp": true,
	"image/gif": true,
};

function errorResponse(
	message: string,
	status: number,
	type: string,
): Response {
	return Response.json(
		{ error: { message, type } },
		{ status, headers: { "Cache-Control": "no-store" } },
	);
}

export async function POST(request: Request): Promise<Response> {
	try {
		await requireUser(request);
	} catch {
		return errorResponse("Not authenticated", 401, "auth_error");
	}

	const bucket = getImagesBucket();

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return errorResponse("Invalid upload", 400, "validation_error");
	}

	const files: File[] = [];
	for (const [, value] of form.entries()) {
		if (typeof value === "object" && value !== null && "arrayBuffer" in value)
			files.push(value as File);
	}

	if (files.length === 0) {
		return errorResponse("No images provided", 400, "validation_error");
	}
	if (files.length > MAX_IMAGES) {
		return errorResponse(
			`Maximum ${MAX_IMAGES} images per upload`,
			400,
			"validation_error",
		);
	}

	const uploaded: { url: string; name: string }[] = [];
	for (const file of files) {
		const mime = file.type.toLowerCase();
		if (!ALLOWED_MIME[mime]) {
			return errorResponse(
				`Unsupported image type: ${file.type}`,
				400,
				"validation_error",
			);
		}
		if (file.size > MAX_IMAGE_BYTES) {
			return errorResponse(
				`Image "${file.name}" exceeds the 10 MB limit`,
				400,
				"validation_error",
			);
		}

		const ext = mime.split("/")[1];
		const key = `${crypto.randomUUID()}.${ext}`;
		await bucket.put(key, file, {
			httpMetadata: { contentType: mime },
		});
		uploaded.push({ url: `/api/playground/images/${key}`, name: file.name });
	}

	return Response.json(
		{ images: uploaded },
		{
			status: 201,
			headers: { "Cache-Control": "private, no-store" },
		},
	);
}
