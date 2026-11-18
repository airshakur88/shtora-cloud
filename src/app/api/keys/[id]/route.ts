import { routeError } from "@/lib/api-error";
import { getDb, getEncryptionSecret } from "@/lib/env";
import { deleteApiKey, listApiKeys, setApiKeyEnabled } from "@/lib/key-store";
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
		await setApiKeyEnabled(
			getDb(),
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
