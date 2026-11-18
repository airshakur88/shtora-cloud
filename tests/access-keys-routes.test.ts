import { beforeEach, expect, mock, test } from "bun:test";
import { createAccessKey, validateAccessKey } from "../src/lib/access-keys";
import type { AppUser } from "../src/lib/types";
import type { MemoryD1 } from "./utils/d1-shim";
import { createParityDatabase } from "./utils/parity-database";

// Access-key routes (M29): create/list/toggle/delete over the route
// handlers, with the session mocked to one user.
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
let currentUser: AppUser | null = USER;

mock.module("../src/lib/env", () => ({
	getDb: () => db,
	getEncryptionSecret: () => "access-key-test-secret-0123456789-abcd",
	getImagesBucket: () => {
		throw new Error("IMAGES_BUCKET is unavailable in this test");
	},
}));
mock.module("../src/lib/session", () => ({
	requireUser: async () => {
		if (!currentUser) {
			const error = new Error("Not authenticated");
			error.name = "UnauthenticatedError";
			throw error;
		}
		return currentUser;
	},
	clearedSessionCookie: () => "",
	sessionCookie: () => "",
	createSession: async () => {
		throw new Error("unexpected session creation in this test");
	},
	deleteSession: async () => {},
	deleteAllSessionsForUser: async () => {},
	getSessionUser: async () => currentUser,
}));

const listRoute = await import("../src/app/api/access-keys/route");
const byIdRoute = await import("../src/app/api/access-keys/[id]/route");

function postJson(url: string, body: unknown): Request {
	return new Request(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
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

beforeEach(async () => {
	db = await createParityDatabase();
	currentUser = USER;
	await insertUser(USER.id, USER.username);
	await insertUser(OTHER.id, OTHER.username);
});

test("POST creates an access key and returns it once, GET lists only the caller's keys", async () => {
	const created = await listRoute.POST(
		postJson("http://localhost/api/access-keys", { name: "cli" }),
	);
	expect(created.status).toBe(201);
	const createdBody = (await created.json()) as {
		accessKey: { apiKey: string; keyPrefix: string; name: string };
	};
	expect(createdBody.accessKey.apiKey.startsWith("ska-")).toBe(true);
	expect(createdBody.accessKey.name).toBe("cli");
	// The full key validates exactly once — the stored row keeps the hash.
	expect(
		(await validateAccessKey(db, createdBody.accessKey.apiKey))?.name,
	).toBe("cli");

	await createAccessKey(db, OTHER.id, { name: "theirs" });
	const listed = await listRoute.GET(
		new Request("http://localhost/api/access-keys"),
	);
	expect(listed.status).toBe(200);
	const listedBody = (await listed.json()) as {
		keys: Array<{ name: string; apiKey?: string }>;
	};
	expect(listedBody.keys).toHaveLength(1);
	expect(listedBody.keys[0].name).toBe("cli");
	// Listing never leaks the secret.
	expect(listedBody.keys[0].apiKey).toBeUndefined();
});

test("POST validates name and expiry", async () => {
	const noName = await listRoute.POST(
		postJson("http://localhost/api/access-keys", {}),
	);
	expect(noName.status).toBe(400);
	const emptyName = await listRoute.POST(
		postJson("http://localhost/api/access-keys", { name: "   " }),
	);
	expect(emptyName.status).toBe(400);
	const longName = await listRoute.POST(
		postJson("http://localhost/api/access-keys", { name: "x".repeat(101) }),
	);
	expect(longName.status).toBe(400);
	const badExpiry = await listRoute.POST(
		postJson("http://localhost/api/access-keys", {
			name: "ok",
			expiresInDays: 0,
		}),
	);
	expect(badExpiry.status).toBe(400);
	const badJson = await listRoute.POST(
		new Request("http://localhost/api/access-keys", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{broken",
		}),
	);
	expect(badJson.status).toBe(400);
});

test("POST with an expiry stores it and the key stops validating after it", async () => {
	const created = await listRoute.POST(
		postJson("http://localhost/api/access-keys", {
			name: "short-lived",
			expiresInDays: 1,
		}),
	);
	expect(created.status).toBe(201);
	const body = (await created.json()) as {
		accessKey: { apiKey: string; expiresAt: string | null };
	};
	expect(body.accessKey.expiresAt).not.toBeNull();
	await db
		.prepare("UPDATE user_access_keys SET expires_at = ? WHERE name = ?")
		.bind("2020-01-01T00:00:00Z", "short-lived")
		.run();
	expect(await validateAccessKey(db, body.accessKey.apiKey)).toBeNull();
});

test("access-key routes without a session answer 401", async () => {
	currentUser = null;
	const listed = await listRoute.GET(
		new Request("http://localhost/api/access-keys"),
	);
	expect(listed.status).toBe(401);
	const created = await listRoute.POST(
		postJson("http://localhost/api/access-keys", { name: "cli" }),
	);
	expect(created.status).toBe(401);
});

test("PATCH toggles enabled and a disabled key stops validating", async () => {
	const created = await createAccessKey(db, USER.id, { name: "toggle-me" });
	const params = { params: Promise.resolve({ id: String(created.id) }) };
	const disabled = await byIdRoute.PATCH(
		new Request(`http://localhost/api/access-keys/${created.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ enabled: false }),
		}),
		params,
	);
	expect(disabled.status).toBe(200);
	expect(await disabled.json()).toEqual({ success: true });
	expect(await validateAccessKey(db, created.apiKey)).toBeNull();
	const enabled = await byIdRoute.PATCH(
		new Request(`http://localhost/api/access-keys/${created.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ enabled: true }),
		}),
		params,
	);
	expect(enabled.status).toBe(200);
	expect((await validateAccessKey(db, created.apiKey))?.id).toBe(created.id);
});

test("PATCH without a boolean enabled answers 400 and bad ids answer 400", async () => {
	const created = await createAccessKey(db, USER.id, { name: "patch-me" });
	const missing = await byIdRoute.PATCH(
		new Request(`http://localhost/api/access-keys/${created.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		}),
		{ params: Promise.resolve({ id: String(created.id) }) },
	);
	expect(missing.status).toBe(400);
	const badId = await byIdRoute.PATCH(
		new Request("http://localhost/api/access-keys/abc", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ enabled: false }),
		}),
		{ params: Promise.resolve({ id: "abc" }) },
	);
	expect(badId.status).toBe(400);
	const badDelete = await byIdRoute.DELETE(
		new Request("http://localhost/api/access-keys/0", { method: "DELETE" }),
		{ params: Promise.resolve({ id: "0" }) },
	);
	expect(badDelete.status).toBe(400);
});

// The 51st access key is a client error like POST /api/keys, which
// answers 403 `limit_reached` at its 50-key cap: createAccessKey throws
// AccessKeyLimitError and the route maps it to 403.
// src/app/api/access-keys/route.ts POST, src/lib/access-keys.ts:103.
test("creating a 51st access key answers 403, not 500", async () => {
	for (let i = 0; i < 50; i += 1) {
		const response = await listRoute.POST(
			postJson("http://localhost/api/access-keys", { name: `key-${i}` }),
		);
		expect(response.status).toBe(201);
	}
	const over = await listRoute.POST(
		postJson("http://localhost/api/access-keys", { name: "key-51" }),
	);
	expect(over.status).toBe(403);
});

test("DELETE removes the caller's key but not another user's", async () => {
	const mine = await createAccessKey(db, USER.id, { name: "mine" });
	const theirs = await createAccessKey(db, OTHER.id, { name: "theirs" });
	const deleted = await byIdRoute.DELETE(
		new Request(`http://localhost/api/access-keys/${mine.id}`, {
			method: "DELETE",
		}),
		{ params: Promise.resolve({ id: String(mine.id) }) },
	);
	expect(deleted.status).toBe(200);
	expect(await deleted.json()).toEqual({ success: true });
	expect(await validateAccessKey(db, mine.apiKey)).toBeNull();
	const kept = await byIdRoute.DELETE(
		new Request(`http://localhost/api/access-keys/${theirs.id}`, {
			method: "DELETE",
		}),
		{ params: Promise.resolve({ id: String(theirs.id) }) },
	);
	expect(kept.status).toBe(200);
	expect((await validateAccessKey(db, theirs.apiKey))?.id).toBe(theirs.id);
});
