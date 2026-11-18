import { AuthRequestError, readLimitedJsonBody } from "@/lib/auth";
import { getDb, getEncryptionSecret } from "@/lib/env";
import { parseKeyImport } from "@/lib/key-import";
import {
	countApiKeysForUser,
	createApiKey,
	MAX_API_KEYS_PER_USER,
} from "@/lib/key-store";
import { requireUser } from "@/lib/session";

/**
 * Import body cap: 512 KiB, enforced by reading the stream with a running
 * total — a chunked body without `content-length` cannot bypass it.
 */
const MAX_IMPORT_BODY_BYTES = 512 * 1024;

export async function POST(request: Request): Promise<Response> {
	try {
		const user = await requireUser(request);

		let body: unknown;
		try {
			body = await readLimitedJsonBody(request, MAX_IMPORT_BODY_BYTES);
		} catch (error) {
			if (error instanceof AuthRequestError && error.status === 413)
				return Response.json(
					{
						error: {
							message: "Request body too large",
							type: "validation_error",
							code: "body_too_large",
						},
					},
					{ status: 413 },
				);
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
		const parseResult = await parseKeyImport(body, getDb());
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

		// Per-user key cap (M1): import only up to the remaining slots;
		// the rest are reported as discarded with `exceeds_limit`.
		const db = getDb();
		const existing = await countApiKeysForUser(db, user.id);
		const remaining = MAX_API_KEYS_PER_USER - existing;
		if (remaining <= 0) {
			return Response.json(
				{
					error: {
						message: `Key limit reached (${MAX_API_KEYS_PER_USER} keys per user)`,
						type: "limit_reached",
					},
				},
				{ status: 403 },
			);
		}
		const importable = keys.slice(0, remaining);
		const overCap = keys.slice(remaining);

		let imported = 0;
		const errors: { reason: string }[] = [];

		// Import each key
		for (const candidate of importable) {
			try {
				await createApiKey(
					db,
					{
						userId: user.id,
						platform: candidate.platform,
						rawKey: candidate.key,
						keyLabel: candidate.label,
					},
					getEncryptionSecret(),
				);
				imported++;
			} catch {
				errors.push({ reason: "import_failed" });
			}
		}

		// Discarded entries, with platform and reason each — nothing is
		// dropped silently. `discarded` is the detailed list; `errors`
		// keeps the previous [{ reason }] shape.
		const discarded = [
			...skipped,
			...overCap.map((candidate) => ({
				platform: candidate.platform,
				reason: "exceeds_limit" as const,
			})),
		];
		for (const skip of discarded) {
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
					discarded,
				},
				{ status: 400 },
			);
		}

		return Response.json(
			{
				imported,
				skipped: errors.length,
				errors,
				discarded,
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
