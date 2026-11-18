import { apiErrorResponse } from "@/lib/api-error";
import { invalidOriginResponse, originAllowed } from "@/lib/csrf";
import { getDb, getImagesBucket } from "@/lib/env";
import { checkImageUploadLimit } from "@/lib/ratelimit";
import { requireUser } from "@/lib/session";
import type { AppUser } from "@/lib/types";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_IMAGES = 10;
/** Per-user quota (M3): 100 images and 200 MB total. A playground message
 * attaches at most 10 images, so this allows roughly 10 fully-loaded
 * messages per user before old images must be replaced. */
const MAX_IMAGES_PER_USER = 100;
const MAX_USER_IMAGE_BYTES = 200 * 1024 * 1024;
const ALLOWED_MIME: Record<string, true> = {
	"image/png": true,
	"image/jpeg": true,
	"image/webp": true,
	"image/gif": true,
};

/**
 * Sniffs the real image type from magic bytes. The declared `file.type`
 * comes from the client and is not trusted on its own.
 */
export function detectImageMime(header: Uint8Array): string | null {
	if (
		header.length >= 8 &&
		header[0] === 0x89 &&
		header[1] === 0x50 &&
		header[2] === 0x4e &&
		header[3] === 0x47 &&
		header[4] === 0x0d &&
		header[5] === 0x0a &&
		header[6] === 0x1a &&
		header[7] === 0x0a
	)
		return "image/png";
	if (
		header.length >= 3 &&
		header[0] === 0xff &&
		header[1] === 0xd8 &&
		header[2] === 0xff
	)
		return "image/jpeg";
	if (
		header.length >= 12 &&
		header[0] === 0x52 && // R
		header[1] === 0x49 && // I
		header[2] === 0x46 && // F
		header[3] === 0x46 && // F
		header[8] === 0x57 && // W
		header[9] === 0x45 && // E
		header[10] === 0x42 && // B
		header[11] === 0x50 // P
	)
		return "image/webp";
	if (
		header.length >= 6 &&
		header[0] === 0x47 && // G
		header[1] === 0x49 && // I
		header[2] === 0x46 && // F
		header[3] === 0x38 && // 8
		(header[4] === 0x37 || header[4] === 0x39) && // 7 or 9
		header[5] === 0x61 // a
	)
		return "image/gif";
	return null;
}

function errorResponse(
	message: string,
	status: number,
	type: string,
	retryAfterSeconds?: number,
): Response {
	const headers: Record<string, string> = {
		"Cache-Control": "no-store",
	};
	if (retryAfterSeconds !== undefined)
		headers["Retry-After"] = String(retryAfterSeconds);
	return apiErrorResponse(message, type, status, headers);
}

interface ValidatedFile {
	file: File;
	mime: string;
	key: string;
}

export async function POST(request: Request): Promise<Response> {
	if (!originAllowed(request)) return invalidOriginResponse();

	let user: AppUser;
	try {
		user = await requireUser(request);
	} catch {
		return errorResponse("Not authenticated", 401, "auth_error");
	}

	const db = getDb();
	const uploadLimit = await checkImageUploadLimit(db, { userId: user.id });
	if (!uploadLimit.ok)
		return errorResponse(
			"Too many uploads, try again shortly",
			429,
			"rate_limited",
			uploadLimit.retryAfterSeconds,
		);

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

	// Validate every file before writing any of them, so a rejected batch
	// leaves no orphaned objects in the bucket.
	const validated: ValidatedFile[] = [];
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
		const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
		if (detectImageMime(header) !== mime) {
			return errorResponse(
				`Image "${file.name}" content does not match its declared type`,
				400,
				"validation_error",
			);
		}
		const ext = mime.split("/")[1];
		validated.push({ file, mime, key: `${crypto.randomUUID()}.${ext}` });
	}

	// Quota check is check-then-act: two concurrent uploads can both pass
	// before either row is written. The counters are small and the abuse
	// ceiling is bounded by the upload rate limit above; exact enforcement
	// would need a serializing transaction the D1 HTTP API does not offer
	// across separate requests.
	const usage = await db
		.prepare(
			"SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM playground_images WHERE user_id = ?",
		)
		.bind(user.id)
		.first<{ n: number; bytes: number }>();
	const existingCount = usage?.n ?? 0;
	const existingBytes = usage?.bytes ?? 0;
	const newBytes = validated.reduce((sum, item) => sum + item.file.size, 0);
	if (existingCount + validated.length > MAX_IMAGES_PER_USER) {
		return errorResponse(
			`Image quota exceeded: maximum ${MAX_IMAGES_PER_USER} images per user`,
			400,
			"validation_error",
		);
	}
	if (existingBytes + newBytes > MAX_USER_IMAGE_BYTES) {
		return errorResponse(
			"Image quota exceeded: maximum 200 MB of images per user",
			400,
			"validation_error",
		);
	}

	const now = Date.now();
	const writtenKeys: string[] = [];
	try {
		for (const item of validated) {
			await bucket.put(item.key, item.file, {
				httpMetadata: { contentType: item.mime },
			});
			writtenKeys.push(item.key);
		}
		await db.batch(
			validated.map((item) =>
				db
					.prepare(
						"INSERT INTO playground_images (key, user_id, size_bytes, content_type, created_at_ms) VALUES (?, ?, ?, ?, ?)",
					)
					.bind(item.key, user.id, item.file.size, item.mime, now),
			),
		);
	} catch {
		// Best-effort cleanup: an object without its ownership row is
		// unreachable through GET, so remove what was just written.
		const cleanup: Promise<unknown>[] = writtenKeys.map((key) =>
			bucket.delete(key),
		);
		if (writtenKeys.length > 0) {
			cleanup.push(
				db
					.prepare(
						`DELETE FROM playground_images WHERE key IN (${writtenKeys.map(() => "?").join(",")})`,
					)
					.bind(...writtenKeys)
					.run(),
			);
		}
		await Promise.allSettled(cleanup);
		return errorResponse("Upload failed", 500, "server_error");
	}

	return Response.json(
		{
			images: validated.map((item) => ({
				url: `/api/playground/images/${item.key}`,
				name: item.file.name,
			})),
		},
		{
			status: 201,
			headers: { "Cache-Control": "private, no-store" },
		},
	);
}
