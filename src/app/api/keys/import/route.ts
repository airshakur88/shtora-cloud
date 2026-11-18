import { getDb, getEncryptionSecret } from "@/lib/env";
import { parseKeyImport } from "@/lib/key-import";
import { createApiKey } from "@/lib/key-store";
import { requireUser } from "@/lib/session";

export async function POST(request: Request): Promise<Response> {
	try {
		const user = await requireUser(request);

		// Get content-length header for size cap
		const contentLength = request.headers.get("content-length");
		if (contentLength && parseInt(contentLength, 10) > 512 * 1024) {
			return Response.json(
				{
					error: {
						message: "Request body too large",
						type: "validation_error",
						code: "body_too_large",
					},
				},
				{ status: 400 },
			);
		}

		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return Response.json(
				{
					error: {
						message: "Invalid JSON",
						type: "validation_error",
						code: "invalid_json",
					},
				},
				{ status: 400 },
			);
		}

		// Parse and validate the import data
		const parseResult = parseKeyImport(body);
		if (!parseResult.success) {
			return Response.json(
				{
					error: {
						message: parseResult.error.message,
						type: "validation_error",
						code: parseResult.error.code,
					},
				},
				{ status: 400 },
			);
		}

		const { keys, skipped } = parseResult.data;

		// Apply caps from parser
		if (
			skipped.length > 0 &&
			skipped.some((s) => s.reason === "exceeds_limit")
		) {
			return Response.json(
				{
					error: {
						message: "Too many keys in import",
						type: "validation_error",
						code: "too_many_keys",
					},
				},
				{ status: 400 },
			);
		}

		let imported = 0;
		const errors: { reason: string }[] = [];

		// Import each key
		for (const candidate of keys) {
			try {
				await createApiKey(
					getDb(),
					{
						userId: user.id,
						platform: candidate.platform,
						rawKey: candidate.key,
						keyLabel: candidate.label,
					},
					getEncryptionSecret(),
				);
				imported++;
			} catch (e) {
				// Record non-secret error
				if (e instanceof Error) {
					errors.push({ reason: "import_failed" });
				} else {
					errors.push({ reason: "unknown_error" });
				}
			}
		}

		// Add skipped entries to errors
		for (const skip of skipped) {
			errors.push({ reason: skip.reason });
		}

		if (imported === 0 && errors.length > 0) {
			return Response.json(
				{
					error: {
						message: "No valid provider keys found in the import.",
						type: "validation_error",
						code: "no_valid_keys",
					},
				},
				{ status: 400 },
			);
		}

		return Response.json(
			{
				imported,
				skipped: errors.length,
				errors,
			},
			{ status: 200 },
		);
	} catch (error) {
		if (error instanceof Error && error.message === "Not authenticated") {
			return Response.json(
				{ error: { message: "Not authenticated", type: "auth_error" } },
				{ status: 401 },
			);
		}
		console.error(
			JSON.stringify({ event: "api_error", path: "/api/keys/import" }),
		);
		return Response.json(
			{ error: { message: "Internal error", type: "server_error" } },
			{ status: 500 },
		);
	}
}
