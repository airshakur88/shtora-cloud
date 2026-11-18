import { beforeEach, expect, mock, test } from "bun:test";
import { getProviderConfig } from "../src/lib/provider-catalog";
import type { AppUser } from "../src/lib/types";
import type { MemoryD1 } from "./utils/d1-shim";
import { createParityDatabase } from "./utils/parity-database";

// POST /api/providers: create a catalog provider row (bearer,
// openai_compatible) over the route handler, with a real session for
// one user. Same setup as access-keys-routes.test.ts: the session
// module stays unmocked, only ../src/lib/env is mocked.
const USER: AppUser = {
	id: "user-1",
	name: "Test User",
	username: "testuser",
	role: "user",
	passwordHash: "",
	createdAt: "",
	updatedAt: "",
};

let db: MemoryD1;
let sessionCookie = "";

mock.module("../src/lib/env", () => ({
	getDb: () => db,
	getEncryptionSecret: () => "providers-test-secret-0123456789-abcd",
	getImagesBucket: () => {
		throw new Error("IMAGES_BUCKET is unavailable in this test");
	},
}));
const { SESSION_COOKIE_NAME, createSession } = await import(
	"../src/lib/session"
);

const createRoute = await import("../src/app/api/providers/route");

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

beforeEach(async () => {
	db = await createParityDatabase();
	await db
		.prepare(
			"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
		)
		.bind(USER.id, USER.username, USER.username, "hash")
		.run();
	const created = await createSession(USER.id);
	sessionCookie = `${SESSION_COOKIE_NAME}=${created.token}`;
});

test("POST creates a provider with limits and returns it", async () => {
	const response = await createRoute.POST(
		postJson("http://localhost/api/providers", {
			id: "acme",
			name: "Acme AI",
			baseUrl: "https://api.acme.dev/v1",
			rpmLimit: 10,
			tpdLimit: 100000,
		}),
	);
	expect(response.status).toBe(201);
	const result: unknown = await response.json();
	expect(result).toMatchObject({
		provider: {
			id: "acme",
			name: "Acme AI",
			baseUrl: "https://api.acme.dev/v1",
			authType: "bearer",
			protocol: "openai_compatible",
			limits: { rpmLimit: 10, tpdLimit: 100000 },
		},
	});
	// The row is readable through the same catalog lookup the router uses.
	const stored = await getProviderConfig("acme", db);
	expect(stored?.name).toBe("Acme AI");
	expect(stored?.limits).toEqual({ rpmLimit: 10, tpdLimit: 100000 });
});

test("POST without limits stores no limits", async () => {
	const response = await createRoute.POST(
		postJson("http://localhost/api/providers", {
			id: "plain",
			name: "Plain",
			baseUrl: "https://api.plain.dev/v1",
		}),
	);
	expect(response.status).toBe(201);
	const stored = await getProviderConfig("plain", db);
	expect(stored?.limits).toBeUndefined();
});

test("POST rejects a duplicate id with 409", async () => {
	const body = {
		id: "acme",
		name: "Acme AI",
		baseUrl: "https://api.acme.dev/v1",
	};
	expect(
		(await createRoute.POST(postJson("http://localhost/api/providers", body)))
			.status,
	).toBe(201);
	const duplicate = await createRoute.POST(
		postJson("http://localhost/api/providers", body),
	);
	expect(duplicate.status).toBe(409);
});

test("POST rejects the reserved id custom with 400", async () => {
	const response = await createRoute.POST(
		postJson("http://localhost/api/providers", {
			id: "custom",
			name: "Custom",
			baseUrl: "https://api.custom.dev/v1",
		}),
	);
	expect(response.status).toBe(400);
});

test("POST rejects an invalid id with 400", async () => {
	const response = await createRoute.POST(
		postJson("http://localhost/api/providers", {
			id: "Bad Id!",
			name: "Bad",
			baseUrl: "https://api.bad.dev/v1",
		}),
	);
	expect(response.status).toBe(400);
});

test("POST rejects a non-https baseUrl with 400", async () => {
	const response = await createRoute.POST(
		postJson("http://localhost/api/providers", {
			id: "acme",
			name: "Acme AI",
			baseUrl: "http://api.acme.dev/v1",
		}),
	);
	expect(response.status).toBe(400);
});

test("POST rejects a private-host baseUrl with 400", async () => {
	const response = await createRoute.POST(
		postJson("http://localhost/api/providers", {
			id: "acme",
			name: "Acme AI",
			baseUrl: "https://localhost:11434/v1",
		}),
	);
	expect(response.status).toBe(400);
});

test("POST rejects an invalid limit with 400", async () => {
	const response = await createRoute.POST(
		postJson("http://localhost/api/providers", {
			id: "acme",
			name: "Acme AI",
			baseUrl: "https://api.acme.dev/v1",
			rpmLimit: -1,
		}),
	);
	expect(response.status).toBe(400);
});

test("POST without a session returns 401", async () => {
	const response = await createRoute.POST(
		postJson(
			"http://localhost/api/providers",
			{
				id: "acme",
				name: "Acme AI",
				baseUrl: "https://api.acme.dev/v1",
			},
			false,
		),
	);
	expect(response.status).toBe(401);
});
