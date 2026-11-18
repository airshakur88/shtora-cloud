import { z } from "zod";
import { routeError } from "@/lib/api-error";
import { AuthRequestError, readLimitedJsonBody } from "@/lib/auth";
import { getDb } from "@/lib/env";
import { parseOptionalLimit } from "@/lib/key-limits";
import { CUSTOM_PLATFORM, getProviderConfig } from "@/lib/provider-catalog";
import { isValidCustomBaseUrl } from "@/lib/providers/public-url";
import { requireUser } from "@/lib/session";

/**
 * Body cap for POST /api/providers: 16 KiB, same as POST /api/keys. A
 * provider row is a name, an id, a baseUrl and four optional limits.
 * Enforced by reading the stream, not by trusting `content-length`.
 */
const MAX_CREATE_PROVIDER_BODY_BYTES = 16 * 1024;

/**
 * Flat creation payload. Limits stay out of the schema on purpose: the
 * shared `parseOptionalLimit` in key-limits.ts is the validator for them,
 * reused rather than duplicated. The id regex is the same slug regex
 * POST /api/keys uses for platform.
 */
const createProviderBodySchema = z.object({
	id: z
		.string()
		.trim()
		.toLowerCase()
		.regex(/^[a-z0-9][a-z0-9._-]{0,79}$/i),
	name: z.string().trim().min(1).max(120),
	baseUrl: z.string().trim().min(1),
	rpmLimit: z.unknown().optional(),
	tpmLimit: z.unknown().optional(),
	rpdLimit: z.unknown().optional(),
	tpdLimit: z.unknown().optional(),
});

function validationError(message: string): Response {
	return Response.json(
		{ error: { message, type: "validation_error" } },
		{ status: 400 },
	);
}

export async function POST(request: Request): Promise<Response> {
	try {
		await requireUser(request);
		let body: unknown;
		try {
			body = await readLimitedJsonBody(request, MAX_CREATE_PROVIDER_BODY_BYTES);
		} catch (error) {
			if (error instanceof AuthRequestError && error.status === 413)
				return Response.json(
					{
						error: {
							message: "Request body too large",
							type: "validation_error",
						},
					},
					{ status: 413 },
				);
			return validationError("Invalid request");
		}
		const parsed = createProviderBodySchema.safeParse(body);
		if (!parsed.success) return validationError("Invalid request");
		const fields = parsed.data;

		// `custom` is the reserved off-catalog escape hatch in POST
		// /api/keys; it must never become a row in the providers table.
		if (fields.id === CUSTOM_PLATFORM)
			return validationError('"custom" is a reserved provider id');

		const db = getDb();
		if ((await getProviderConfig(fields.id, db)) !== undefined)
			return Response.json(
				{
					error: {
						message: `Provider already exists: ${fields.id}`,
						type: "conflict",
					},
				},
				{ status: 409 },
			);

		if (!isValidCustomBaseUrl(fields.baseUrl))
			return validationError("Invalid request");

		const limitFields = [
			"rpmLimit",
			"tpmLimit",
			"rpdLimit",
			"tpdLimit",
		] as const;
		const parsedLimits: Record<string, number | null> = {};
		for (const field of limitFields) {
			const value = fields[field];
			if (value === undefined) continue;
			const parsedLimit = parseOptionalLimit(value);
			if (parsedLimit === undefined)
				return validationError(
					`${field} must be an integer between 0 and 10000000`,
				);
			parsedLimits[field] = parsedLimit;
		}
		// Only limits the caller set are stored; the rest stay unset and
		// keys for this provider fall back to the gateway default.
		const limitsEntries = limitFields.filter(
			(field) =>
				parsedLimits[field] !== null && parsedLimits[field] !== undefined,
		);
		const limitsJson =
			limitsEntries.length > 0
				? JSON.stringify(
						Object.fromEntries(
							limitsEntries.map((field) => [field, parsedLimits[field]]),
						),
					)
				: null;

		// New providers are plain OpenAI-compatible bearer endpoints. No
		// models are attached here; models arrive with the catalog.
		await db
			.prepare(
				`INSERT INTO providers
					(id, name, base_url, auth_type, protocol, description, keyless,
					 key_hint, extra_headers, force_single_tool_call, model_identity,
					 model_aliases, electron_hub_proxy_error, ensure_done, limits)
				 VALUES (?, ?, ?, 'bearer', 'openai_compatible', NULL, 0, NULL,
					NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
			)
			.bind(fields.id, fields.name, fields.baseUrl, limitsJson)
			.run();
		const provider = await getProviderConfig(fields.id, db);
		return Response.json({ provider }, { status: 201 });
	} catch (error) {
		return routeError(error, "/api/providers");
	}
}
