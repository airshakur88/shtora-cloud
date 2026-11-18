import { deleteSession, getSessionUser, publicUser } from "@/lib/session";

export async function GET(request: Request): Promise<Response> {
	try {
		const user = await getSessionUser(request);
		return Response.json({ user: user ? publicUser(user) : null });
	} catch {
		return Response.json({ error: "internal_error" }, { status: 500 });
	}
}

export async function DELETE(request: Request): Promise<Response> {
	try {
		await deleteSession(request);
		return new Response(null, { status: 204 });
	} catch {
		return Response.json({ error: "internal_error" }, { status: 500 });
	}
}
