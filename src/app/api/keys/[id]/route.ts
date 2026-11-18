import { routeError } from "@/lib/api-error";
import { getDb, getEncryptionSecret } from "@/lib/env";
import { parseOptionalLimit } from "@/lib/key-limits";
import {
	deleteApiKey,
	listApiKeys,
	setApiKeyEnabled,
	updateKeyLimits,
} from "@/lib/key-store";
import { getProviderConfig } from "@/lib/provider-catalog";
import { requireUser } from "@/lib/session";

function parseId(raw: string): number | null {
	const id = Number(raw);
	return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
): Promise<Response> {
	try {
		const user = await requireUser(request);
		const id = parseId((await params).id);
		if (id === null)
			return Response.json(
				{ error: { message: "Invalid id", type: "validation_error" } },
				{ status: 400 },
			);
		const keys = await listApiKeys(getDb(), user.id, getEncryptionSecret());
		const key = keys.find((item) => item.id === id);
		if (!key)
			return Response.json(
				{ error: { message: "Key not found", type: "not_found" } },
				{ status: 404 },
			);
		return Response.json({ key });
	} catch (error) {
		return routeError(error, "/api/keys/[id]");
	}
}

export async function PATCH(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
): Promise<Response> {
	try {
		const user = await requireUser(request);
		const id = parseId((await params).id);
		if (id === null)
			return Response.json(
				{ error: { message: "Invalid id", type: "validation_error" } },
				{ status: 400 },
			);
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return Response.json(
				{ error: { message: "Invalid request", type: "validation_error" } },
				{ status: 400 },
			);
		}
		if (
			!body ||
			typeof body !== "object" ||
			Array.isArray(body) ||
			typeof (body as Record<string, unknown>).enabled !== "boolean"
		) {
			return Response.json(
				{
					error: {
						message: "enabled must be a boolean",
						type: "validation_error",
					},
				},
				{ status: 400 },
			);
		}
		const fields = body as Record<string, unknown>;
		// Optional limit edits. A number sets the limit, null resets it to
		// the provider catalog default (same rule as POST), omitted leaves
		// the stored value alone. Invalid values are rejected, not ignored.
		const limitFields = [
			"rpmLimit",
			"tpmLimit",
			"rpdLimit",
			"tpdLimit",
		] as const;
		const parsedLimits: Record<string, number | null | undefined> = {};
		for (const field of limitFields) {
			if (!(field in fields)) continue;
			const parsed = parseOptionalLimit(fields[field]);
			if (parsed === undefined)
				return Response.json(
					{
						error: {
							message: `${field} must be an integer between 0 and 10000000`,
							type: "validation_error",
						},
					},
					{ status: 400 },
				);
			parsedLimits[field] = parsed;
		}
		const db = getDb();
		const hasLimitEdit = Object.keys(parsedLimits).length > 0;
		if (hasLimitEdit) {
			const current = (
				await listApiKeys(db, user.id, getEncryptionSecret())
			).find((item) => item.id === id);
			if (!current)
				return Response.json(
					{ error: { message: "Key not found", type: "not_found" } },
					{ status: 404 },
				);
			const catalogLimits = (await getProviderConfig(current.platform, db))
				?.limits;
			await updateKeyLimits(db, id, user.id, {
				rpmLimit:
					parsedLimits.rpmLimit !== undefined
						? (parsedLimits.rpmLimit ?? catalogLimits?.rpmLimit ?? null)
						: current.rpmLimit,
				tpmLimit:
					parsedLimits.tpmLimit !== undefined
						? (parsedLimits.tpmLimit ?? catalogLimits?.tpmLimit ?? null)
						: current.tpmLimit,
				rpdLimit:
					parsedLimits.rpdLimit !== undefined
						? (parsedLimits.rpdLimit ?? catalogLimits?.rpdLimit ?? null)
						: current.rpdLimit,
				tpdLimit:
					parsedLimits.tpdLimit !== undefined
						? (parsedLimits.tpdLimit ?? catalogLimits?.tpdLimit ?? null)
						: current.tpdLimit,
			});
		}
		await setApiKeyEnabled(
			db,
			id,
			user.id,
			(body as { enabled: boolean }).enabled,
		);
		const key = (
			await listApiKeys(getDb(), user.id, getEncryptionSecret())
		).find((item) => item.id === id);
		if (!key)
			return Response.json(
				{ error: { message: "Key not found", type: "not_found" } },
				{ status: 404 },
			);
		return Response.json({ key });
	} catch (error) {
		return routeError(error, "/api/keys/[id]");
	}
}

export async function DELETE(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
): Promise<Response> {
	try {
		const user = await requireUser(request);
		const id = parseId((await params).id);
		if (id === null)
			return Response.json(
				{ error: { message: "Invalid id", type: "validation_error" } },
				{ status: 400 },
			);
		await deleteApiKey(getDb(), id, user.id);
		return new Response(null, { status: 204 });
	} catch (error) {
		return routeError(error, "/api/keys/[id]");
	}
}
