import { z } from "zod";
import { routeError } from "@/lib/api-error";
import { AuthRequestError, readLimitedJsonBody } from "@/lib/auth";
import { getDb, getEncryptionSecret } from "@/lib/env";
import { parseOptionalLimit, withEffectiveLimits } from "@/lib/key-limits";
import {
	countApiKeysForUser,
	createApiKey,
	listApiKeys,
	MAX_API_KEYS_PER_USER,
} from "@/lib/key-store";
import {
	CUSTOM_PLATFORM,
	getProviderConfig,
	normalizeProviderKey,
} from "@/lib/provider-catalog";
import { isPrivateEndpointHost } from "@/lib/providers/public-url";
import { requireUser } from "@/lib/session";
import type { KeyInput } from "@/lib/types";

/**
 * Body cap for POST /api/keys: 16 KiB. A provider key is at most 8.192
 * chars; the rest (label, limits, baseUrl) fits in the remaining margin.
 * Enforced by reading the stream, not by trusting `content-length`.
 */
const MAX_CREATE_KEY_BODY_BYTES = 16 * 1024;

/**
 * Flat creation payload. Limits stay out of the schema on purpose: the
 * shared `parseOptionalLimit` in key-limits.ts is the validator for them,
 * reused rather than duplicated.
 */
const createKeyBodySchema = z.object({
	platform: z
		.string()
		.trim()
		.toLowerCase()
		.regex(/^[a-z0-9][a-z0-9._-]{0,79}$/i),
	rawKey: z.string().max(8192).optional(),
	keyLabel: z.string().max(120).nullable().optional(),
	baseUrl: z.string().nullable().optional(),
	keyless: z.boolean().optional(),
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

export async function GET(request: Request): Promise<Response> {
	try {
		const user = await requireUser(request);
		const db = getDb();
		const keys = await listApiKeys(db, user.id, getEncryptionSecret());
		return Response.json({
			keys: await withEffectiveLimits(db, keys),
		});
	} catch (error) {
		return routeError(error, "/api/keys");
	}
}

export async function POST(request: Request): Promise<Response> {
	try {
		const user = await requireUser(request);
		let body: unknown;
		try {
			body = await readLimitedJsonBody(request, MAX_CREATE_KEY_BODY_BYTES);
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
		const parsed = createKeyBodySchema.safeParse(body);
		if (!parsed.success) return validationError("Invalid request");
		const fields = parsed.data;
		const normalizedPlatform = fields.platform;
		const isKeyless = fields.keyless === true;
		const normalizedRawKey = await normalizeProviderKey(
			normalizedPlatform,
			fields.rawKey,
			isKeyless,
			getDb(),
		);
		if (normalizedRawKey === null) return validationError("Invalid request");

		// C1: the platform must exist in the catalog, except for the
		// explicit `custom` escape hatch. Anything else (notably `openai`,
		// which has no catalog row — `anthropic` gained one in migration
		// 0015) is rejected instead of becoming a key with an
		// attacker-controlled baseUrl.
		const db = getDb();
		const catalogProvider = await getProviderConfig(normalizedPlatform, db);
		// Same check `isKnownProvider` performs (it wraps this lookup);
		// the config row is needed below for the catalog limits, so the
		// lookup is done once here instead of twice.
		const isCatalogPlatform = catalogProvider !== undefined;
		const isCustom = normalizedPlatform === CUSTOM_PLATFORM;
		if (!isCatalogPlatform && !isCustom)
			return validationError(
				`Unknown provider platform: ${normalizedPlatform}`,
			);
		const normalizedBaseUrl =
			typeof fields.baseUrl === "string" ? fields.baseUrl.trim() : null;
		if (isCatalogPlatform && normalizedBaseUrl)
			return validationError(
				'baseUrl is not allowed for catalog providers; use platform "custom" for a custom endpoint',
			);
		if (isCustom && !normalizedBaseUrl)
			return validationError('baseUrl is required for platform "custom"');

		// User-provided limits override catalog defaults when present and valid
		const catalogLimits = catalogProvider?.limits;
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
		const rpmLimit = parsedLimits.rpmLimit ?? catalogLimits?.rpmLimit ?? null;
		const tpmLimit = parsedLimits.tpmLimit ?? catalogLimits?.tpmLimit ?? null;
		const rpdLimit = parsedLimits.rpdLimit ?? catalogLimits?.rpdLimit ?? null;
		const tpdLimit = parsedLimits.tpdLimit ?? catalogLimits?.tpdLimit ?? null;

		if (normalizedBaseUrl) {
			let parsedUrl: URL;
			try {
				parsedUrl = new URL(normalizedBaseUrl);
			} catch {
				return validationError("Invalid request");
			}
			if (
				parsedUrl.protocol !== "https:" ||
				parsedUrl.username ||
				parsedUrl.password ||
				parsedUrl.search ||
				parsedUrl.hash ||
				isPrivateEndpointHost(parsedUrl.hostname)
			) {
				return validationError("Invalid request");
			}
		}
		if ((await countApiKeysForUser(db, user.id)) >= MAX_API_KEYS_PER_USER)
			return Response.json(
				{
					error: {
						message: `Key limit reached (${MAX_API_KEYS_PER_USER} keys per user)`,
						type: "limit_reached",
					},
				},
				{ status: 403 },
			);
		const input: KeyInput = {
			userId: user.id,
			platform: normalizedPlatform,
			rawKey: normalizedRawKey,
			keyLabel:
				typeof fields.keyLabel === "string" && fields.keyLabel.trim()
					? fields.keyLabel.trim()
					: null,
			baseUrl: normalizedBaseUrl,
			rpmLimit,
			tpmLimit,
			rpdLimit,
			tpdLimit,
		};
		const key = await createApiKey(getDb(), input, getEncryptionSecret());
		return Response.json(
			{ key, unifiedToken: key.unifiedToken },
			{ status: 201 },
		);
	} catch (error) {
		return routeError(error, "/api/keys");
	}
}
