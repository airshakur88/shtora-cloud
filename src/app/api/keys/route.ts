import { routeError } from "@/lib/api-error";
import { getDb, getEncryptionSecret } from "@/lib/env";
import { parseOptionalLimit, withEffectiveLimits } from "@/lib/key-limits";
import { createApiKey, listApiKeys } from "@/lib/key-store";
import {
	getProviderConfig,
	normalizeProviderKey,
} from "@/lib/provider-catalog";
import { isPrivateEndpointHost } from "@/lib/providers/public-url";
import { requireUser } from "@/lib/session";
import type { KeyInput } from "@/lib/types";

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
			body = await request.json();
		} catch {
			return Response.json(
				{ error: { message: "Invalid request", type: "validation_error" } },
				{ status: 400 },
			);
		}
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			return Response.json(
				{ error: { message: "Invalid request", type: "validation_error" } },
				{ status: 400 },
			);
		}
		const fields = body as Record<string, unknown>;
		const { platform, rawKey } = fields;
		const normalizedPlatform =
			typeof platform === "string" ? platform.trim().toLowerCase() : "";
		const isKeyless = fields.keyless === true;
		const normalizedRawKey = await normalizeProviderKey(
			normalizedPlatform,
			rawKey,
			isKeyless,
			getDb(),
		);
		const keyLabel = fields.keyLabel;
		const baseUrl = fields.baseUrl;

		const catalogProvider = await getProviderConfig(
			normalizedPlatform,
			getDb(),
		);
		const catalogLimits = catalogProvider?.limits;

		// User-provided limits override catalog defaults when present and valid
		const rpmLimit =
			parseOptionalLimit(fields.rpmLimit) ?? catalogLimits?.rpmLimit ?? null;
		const tpmLimit =
			parseOptionalLimit(fields.tpmLimit) ?? catalogLimits?.tpmLimit ?? null;
		const rpdLimit =
			parseOptionalLimit(fields.rpdLimit) ?? catalogLimits?.rpdLimit ?? null;
		const tpdLimit =
			parseOptionalLimit(fields.tpdLimit) ?? catalogLimits?.tpdLimit ?? null;

		const rawKeyProvided = "rawKey" in fields && typeof rawKey === "string";
		if (
			typeof platform !== "string" ||
			!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(platform.trim()) ||
			(rawKeyProvided && typeof rawKey !== "string") ||
			normalizedRawKey === null ||
			(rawKeyProvided && rawKey.length > 8192) ||
			(keyLabel !== undefined &&
				keyLabel !== null &&
				(typeof keyLabel !== "string" || keyLabel.length > 120)) ||
			(baseUrl !== undefined && baseUrl !== null && typeof baseUrl !== "string")
		) {
			return Response.json(
				{ error: { message: "Invalid request", type: "validation_error" } },
				{ status: 400 },
			);
		}
		const normalizedBaseUrl =
			typeof baseUrl === "string" ? baseUrl.trim() : null;
		if (normalizedBaseUrl) {
			let parsed: URL;
			try {
				parsed = new URL(normalizedBaseUrl);
			} catch {
				return Response.json(
					{ error: { message: "Invalid request", type: "validation_error" } },
					{ status: 400 },
				);
			}
			if (
				parsed.protocol !== "https:" ||
				parsed.username ||
				parsed.password ||
				parsed.search ||
				parsed.hash ||
				isPrivateEndpointHost(parsed.hostname)
			) {
				return Response.json(
					{ error: { message: "Invalid request", type: "validation_error" } },
					{ status: 400 },
				);
			}
		}
		const input: KeyInput = {
			userId: user.id,
			platform: normalizedPlatform,
			rawKey: normalizedRawKey,
			keyLabel:
				typeof keyLabel === "string" && keyLabel.trim()
					? keyLabel.trim()
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
