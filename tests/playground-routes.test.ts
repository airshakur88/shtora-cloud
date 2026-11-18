import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { createApiKey } from "../src/lib/key-store";
import {
	createSession as createPlaygroundSession,
	DEFAULT_SESSION_NAME,
} from "../src/lib/playground-sessions";
import type { AppUser } from "../src/lib/types";
import type { MemoryD1 } from "./utils/d1-shim";
import { createParityDatabase } from "./utils/parity-database";

// Playground routes (M29): sessions CRUD and the chat route, driven
// through the route handlers with a mocked fetch upstream.
const SECRET = "playground-test-secret-0123456789-abcdefghijklmnop";

const USER: AppUser = {
	id: "user-1",
	name: "Test User",
	username: "testuser",
	role: "user",
	passwordHash: "",
	createdAt: "",
	updatedAt: "",
};
const OTHER: AppUser = {
	...USER,
	id: "user-2",
	username: "otheruser",
	name: "Other User",
};

let db: MemoryD1;
// Real session for USER, created per test: the routes authenticate
// through the real session module, not a mock. A mock.module for
// ../src/lib/session here would leak into every other test file in the
// same `bun test` run (Bun shares mocked modules across files).
let sessionCookie = "";
// The fake R2 bucket: only `get` is used by the chat route (image
// resolution); uploads are covered by playground-images-security.test.ts.
const bucketGet = mock(async (_key: string) => null);

mock.module("../src/lib/env", () => ({
	getDb: () => db,
	getEncryptionSecret: () => SECRET,
	getImagesBucket: () => ({
		get: bucketGet,
		put: async () => {},
		delete: async () => {},
	}),
}));
const { SESSION_COOKIE_NAME, createSession } = await import(
	"../src/lib/session"
);

const sessionsRoute = await import("../src/app/api/playground/sessions/route");
const sessionByIdRoute = await import(
	"../src/app/api/playground/sessions/[id]/route"
);
const chatRoute = await import("../src/app/api/playground/chat/route");

const originalFetch = globalThis.fetch;

function postJson(url: string, body: unknown, withAuth = true): Request {
	return new Request(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(withAuth ? { Cookie: sessionCookie } : {}),
		},
		body: JSON.stringify(body),
	});
}

async function insertUser(id: string, username: string): Promise<void> {
	await db
		.prepare(
			"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
		)
		.bind(id, username, username, "hash")
		.run();
}

async function seedChatFixtures(): Promise<void> {
	await db
		.prepare(
			"INSERT INTO models (platform, model_id, name, context_window, intelligence_rank, tier) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.bind("groq", "model-a", "Model A", 32768, 1, 1)
		.run();
	await db
		.prepare(
			"INSERT INTO models (platform, model_id, name, context_window, intelligence_rank, tier) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.bind("groq", "model-b", "Model B", 32768, 2, 1)
		.run();
	await createApiKey(
		db,
		{
			userId: USER.id,
			platform: "groq",
			rawKey: "gsk-playground",
			keyLabel: null,
		},
		SECRET,
	);
}

function mockUpstreamStream(content: string): void {
	// SSE events are separated by a blank line; without it the [DONE]
	// line folds into the first event's data and the stream is dropped.
	const upstream = [
		`data: ${JSON.stringify({
			id: "chatcmpl-stream",
			object: "chat.completion.chunk",
			created: 0,
			model: "model-a",
			choices: [{ index: 0, delta: { content }, finish_reason: null }],
		})}`,
		"data: [DONE]",
		"",
	].join("\n\n");
	globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
		new Response(upstream, {
			headers: { "Content-Type": "text/event-stream" },
		})) as typeof fetch;
}

beforeEach(async () => {
	db = await createParityDatabase();
	await insertUser(USER.id, USER.username);
	await insertUser(OTHER.id, OTHER.username);
	const created = await createSession(USER.id);
	sessionCookie = `${SESSION_COOKIE_NAME}=${created.token}`;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("POST /api/playground/sessions creates a session with defaults when the body is empty", async () => {
	const response = await sessionsRoute.POST(
		postJson("http://localhost/api/playground/sessions", {}),
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		name: string;
		modelId: string;
		userId: string;
	};
	expect(body.name).toBe(DEFAULT_SESSION_NAME);
	expect(body.modelId).toBe("google/gemini-2.5-flash");
	expect(body.userId).toBe(USER.id);
});

test("GET /api/playground/sessions lists only the caller's sessions", async () => {
	await createPlaygroundSession(db, USER.id, "groq/model-a");
	await createPlaygroundSession(db, OTHER.id, "groq/model-a");
	const response = await sessionsRoute.GET(
		new Request("http://localhost/api/playground/sessions", {
			headers: { Cookie: sessionCookie },
		}),
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		sessions: Array<{ userId: string }>;
	};
	expect(body.sessions).toHaveLength(1);
	expect(body.sessions[0].userId).toBe(USER.id);
});

test("GET /api/playground/sessions without a session answers 401", async () => {
	const response = await sessionsRoute.GET(
		new Request("http://localhost/api/playground/sessions"),
	);
	expect(response.status).toBe(401);
});

test("GET /api/playground/sessions/[id] returns the session and hides other users'", async () => {
	const mine = await createPlaygroundSession(db, USER.id, "groq/model-a");
	const theirs = await createPlaygroundSession(db, OTHER.id, "groq/model-a");
	const found = await sessionByIdRoute.GET(
		new Request(`http://localhost/api/playground/sessions/${mine.id}`, {
			headers: { Cookie: sessionCookie },
		}),
		{ params: Promise.resolve({ id: mine.id }) },
	);
	expect(found.status).toBe(200);
	const foundBody = (await found.json()) as {
		session: { id: string };
	};
	expect(foundBody.session.id).toBe(mine.id);
	const hidden = await sessionByIdRoute.GET(
		new Request(`http://localhost/api/playground/sessions/${theirs.id}`, {
			headers: { Cookie: sessionCookie },
		}),
		{ params: Promise.resolve({ id: theirs.id }) },
	);
	expect(hidden.status).toBe(404);
	const missing = await sessionByIdRoute.GET(
		new Request("http://localhost/api/playground/sessions/nope", {
			headers: { Cookie: sessionCookie },
		}),
		{ params: Promise.resolve({ id: "nope" }) },
	);
	expect(missing.status).toBe(404);
});

test("PATCH renames a session, validates the model and rejects empty names", async () => {
	await seedChatFixtures();
	const session = await createPlaygroundSession(db, USER.id, "groq/model-a");
	const params = { params: Promise.resolve({ id: session.id }) };
	const renamed = await sessionByIdRoute.PATCH(
		new Request(`http://localhost/api/playground/sessions/${session.id}`, {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
				Cookie: sessionCookie,
			},
			body: JSON.stringify({ name: "My chat", modelId: "groq/model-b" }),
		}),
		params,
	);
	expect(renamed.status).toBe(200);
	const renamedBody = (await renamed.json()) as {
		name: string;
		modelId: string;
	};
	expect(renamedBody.name).toBe("My chat");
	expect(renamedBody.modelId).toBe("groq/model-b");

	const emptyName = await sessionByIdRoute.PATCH(
		new Request(`http://localhost/api/playground/sessions/${session.id}`, {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
				Cookie: sessionCookie,
			},
			body: JSON.stringify({ name: "   " }),
		}),
		params,
	);
	expect(emptyName.status).toBe(400);

	const unknownModel = await sessionByIdRoute.PATCH(
		new Request(`http://localhost/api/playground/sessions/${session.id}`, {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
				Cookie: sessionCookie,
			},
			body: JSON.stringify({ modelId: "nope/nope" }),
		}),
		params,
	);
	expect(unknownModel.status).toBe(400);

	const router = await sessionByIdRoute.PATCH(
		new Request(`http://localhost/api/playground/sessions/${session.id}`, {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
				Cookie: sessionCookie,
			},
			body: JSON.stringify({ modelId: "shtora/auto" }),
		}),
		params,
	);
	expect(router.status).toBe(200);
});

test("PATCH on another user's session answers 404", async () => {
	const theirs = await createPlaygroundSession(db, OTHER.id, "groq/model-a");
	const response = await sessionByIdRoute.PATCH(
		new Request(`http://localhost/api/playground/sessions/${theirs.id}`, {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
				Cookie: sessionCookie,
			},
			body: JSON.stringify({ name: "hijack" }),
		}),
		{ params: Promise.resolve({ id: theirs.id }) },
	);
	expect(response.status).toBe(404);
});

test("DELETE removes a session and a second DELETE answers 404", async () => {
	const session = await createPlaygroundSession(db, USER.id, "groq/model-a");
	const params = { params: Promise.resolve({ id: session.id }) };
	const deleted = await sessionByIdRoute.DELETE(
		new Request(`http://localhost/api/playground/sessions/${session.id}`, {
			method: "DELETE",
			headers: { Cookie: sessionCookie },
		}),
		params,
	);
	expect(deleted.status).toBe(200);
	expect(await deleted.json()).toEqual({ success: true });
	const again = await sessionByIdRoute.DELETE(
		new Request(`http://localhost/api/playground/sessions/${session.id}`, {
			method: "DELETE",
			headers: { Cookie: sessionCookie },
		}),
		params,
	);
	expect(again.status).toBe(404);
});

test("POST /api/playground/chat streams the upstream reply and titles the session from the first message", async () => {
	await seedChatFixtures();
	const session = await createPlaygroundSession(db, USER.id, "groq/model-a");
	mockUpstreamStream("four");
	const response = await chatRoute.POST(
		postJson("http://localhost/api/playground/chat", {
			sessionId: session.id,
			messages: [{ role: "user", content: "Hello, what is 2+2?" }],
		}),
	);
	expect(response.status).toBe(200);
	expect(response.headers.get("Content-Type")).toContain("text/event-stream");
	expect(await response.text()).toContain("four");
	const renamed = await db
		.prepare("SELECT name FROM playground_sessions WHERE id = ?")
		.bind(session.id)
		.first<{ name: string }>();
	expect(renamed?.name).toBe("Hello, what is 2+2?");
});

test("chat keeps a renamed session's name and answers 404 for an unknown session", async () => {
	await seedChatFixtures();
	const session = await createPlaygroundSession(db, USER.id, "groq/model-a");
	await db
		.prepare("UPDATE playground_sessions SET name = ? WHERE id = ?")
		.bind("My chat", session.id)
		.run();
	mockUpstreamStream("four");
	const response = await chatRoute.POST(
		postJson("http://localhost/api/playground/chat", {
			sessionId: session.id,
			messages: [{ role: "user", content: "Something else entirely" }],
		}),
	);
	expect(response.status).toBe(200);
	const kept = await db
		.prepare("SELECT name FROM playground_sessions WHERE id = ?")
		.bind(session.id)
		.first<{ name: string }>();
	expect(kept?.name).toBe("My chat");

	const missing = await chatRoute.POST(
		postJson("http://localhost/api/playground/chat", {
			sessionId: "no-such-session",
			messages: [{ role: "user", content: "hi" }],
		}),
	);
	expect(missing.status).toBe(404);
});

test("chat validates its body before routing", async () => {
	await seedChatFixtures();
	const session = await createPlaygroundSession(db, USER.id, "groq/model-a");
	const noMessages = await chatRoute.POST(
		postJson("http://localhost/api/playground/chat", {
			sessionId: session.id,
		}),
	);
	expect(noMessages.status).toBe(400);
	const noValidMessages = await chatRoute.POST(
		postJson("http://localhost/api/playground/chat", {
			sessionId: session.id,
			messages: [{ role: "bogus", content: "hi" }],
		}),
	);
	expect(noValidMessages.status).toBe(400);
});

test("chat with a missing playground image answers 422", async () => {
	await seedChatFixtures();
	const session = await createPlaygroundSession(db, USER.id, "groq/model-a");
	const response = await chatRoute.POST(
		postJson("http://localhost/api/playground/chat", {
			sessionId: session.id,
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "describe this" },
						{
							type: "image_url",
							image_url: {
								url: "/api/playground/images/11111111-1111-4111-8111-111111111111.png",
							},
						},
					],
				},
			],
		}),
	);
	expect(response.status).toBe(422);
	expect(bucketGet).toHaveBeenCalled();
});

test("chat without a session answers 401", async () => {
	const response = await chatRoute.POST(
		postJson(
			"http://localhost/api/playground/chat",
			{
				sessionId: "whatever",
				messages: [{ role: "user", content: "hi" }],
			},
			false,
		),
	);
	expect(response.status).toBe(401);
});
