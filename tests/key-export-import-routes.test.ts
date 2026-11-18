import { beforeEach, expect, mock, test } from "bun:test";
import { createApiKey, listApiKeys } from "../src/lib/key-store";
import type { AppUser } from "../src/lib/types";
import type { MemoryD1 } from "./utils/d1-shim";
import { createParityDatabase } from "./utils/parity-database";

// Key export/import/delete routes (M29): the parser alone was tested
// before; these tests drive the route handlers end to end.
const SECRET = "key-routes-test-secret-0123456789-abcdefghijklmnop";

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
// Mutable session: tests set it to null to exercise the 401 path.
let currentUser: AppUser | null = USER;

mock.module("../src/lib/env", () => ({
	getDb: () => db,
	getEncryptionSecret: () => SECRET,
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

const exportRoute = await import("../src/app/api/keys/export/route");
const importRoute = await import("../src/app/api/keys/import/route");
const keysRoute = await import("../src/app/api/keys/route");
const keyByIdRoute = await import("../src/app/api/keys/[id]/route");

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

test("POST /api/keys creates a key and returns its unified token once", async () => {
	const response = await keysRoute.POST(
		postJson("http://localhost/api/keys", {
			platform: "groq",
			rawKey: "gsk-created-via-route",
			keyLabel: "route key",
		}),
	);
	expect(response.status).toBe(201);
	const body = (await response.json()) as {
		key: { platform: string; maskedKey: string; rpmLimit: number | null };
		unifiedToken: string;
	};
	expect(body.key.platform).toBe("groq");
	expect(body.key.maskedKey).toBe("••••oute");
	expect(body.unifiedToken.startsWith("flmr-")).toBe(true);
	// The catalog default rpm for groq applies when no limit is given.
	expect(body.key.rpmLimit).toBeGreaterThan(0);
	const stored = await db
		.prepare("SELECT unified_token FROM api_keys WHERE user_id = ?")
		.bind(USER.id)
		.first<{ unified_token: string }>();
	// Only the hash is stored; the plaintext token never persists.
	expect(stored?.unified_token).not.toBe(body.unifiedToken);
});

test("POST /api/keys rejects a platform with no catalog row", async () => {
	const response = await keysRoute.POST(
		postJson("http://localhost/api/keys", {
			platform: "openai",
			rawKey: "sk-openai-1",
		}),
	);
	expect(response.status).toBe(400);
});

test("POST /api/keys answers 403 at the 50-key cap", async () => {
	for (let i = 0; i < 50; i += 1) {
		await createApiKey(
			db,
			{
				userId: USER.id,
				platform: "groq",
				rawKey: `gsk-cap-${i}`,
				keyLabel: null,
			},
			SECRET,
		);
	}
	const response = await keysRoute.POST(
		postJson("http://localhost/api/keys", {
			platform: "groq",
			rawKey: "gsk-one-more",
		}),
	);
	expect(response.status).toBe(403);
	expect(await response.json()).toEqual({
		error: {
			message: "Key limit reached (50 keys per user)",
			type: "limit_reached",
		},
	});
});

test("GET /api/keys lists only the caller's keys, masked", async () => {
	await createApiKey(
		db,
		{
			userId: USER.id,
			platform: "groq",
			rawKey: "gsk-list-me",
			keyLabel: null,
		},
		SECRET,
	);
	await createApiKey(
		db,
		{
			userId: OTHER.id,
			platform: "groq",
			rawKey: "gsk-not-mine",
			keyLabel: null,
		},
		SECRET,
	);
	const response = await keysRoute.GET(
		new Request("http://localhost/api/keys"),
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		keys: Array<{ maskedKey: string; unifiedToken?: string }>;
	};
	expect(body.keys).toHaveLength(1);
	expect(body.keys[0].maskedKey).toBe("••••t-me");
	expect(body.keys[0].unifiedToken).toBeUndefined();
});

test("POST /api/keys/export returns the user's keys in plaintext", async () => {
	await createApiKey(
		db,
		{
			userId: USER.id,
			platform: "groq",
			rawKey: "gsk-export-me-1234",
			keyLabel: "main",
		},
		SECRET,
	);
	await createApiKey(
		db,
		{
			userId: OTHER.id,
			platform: "groq",
			rawKey: "gsk-not-mine-9999",
			keyLabel: null,
		},
		SECRET,
	);
	const response = await exportRoute.POST(
		new Request("http://localhost/api/keys/export", { method: "POST" }),
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		version: number;
		source: string;
		exportedBy: string;
		keys: Array<{ platform: string; key: string; label: string | null }>;
	};
	expect(body.version).toBe(1);
	expect(body.source).toBe("shtora-cloud");
	expect(body.exportedBy).toBe(USER.id);
	expect(body.keys).toHaveLength(1);
	expect(body.keys[0]).toEqual({
		platform: "groq",
		key: "gsk-export-me-1234",
		label: "main",
	});
});

test("GET /api/keys/export answers 405 and export without a session answers 401", async () => {
	const get = await exportRoute.GET();
	expect(get.status).toBe(405);
	expect(get.headers.get("Allow")).toBe("POST");
	currentUser = null;
	const post = await exportRoute.POST(
		new Request("http://localhost/api/keys/export", { method: "POST" }),
	);
	expect(post.status).toBe(401);
});

test("POST /api/keys/import imports valid keys and reports the discarded ones", async () => {
	const response = await importRoute.POST(
		postJson("http://localhost/api/keys/import", {
			version: 1,
			source: "shtora-cloud",
			keys: [
				{ platform: "groq", key: "gsk-imported-1", label: "a" },
				{ platform: "openai", key: "sk-openai-1" },
				{ platform: "groq", key: "" },
			],
		}),
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		imported: number;
		skipped: number;
		discarded: Array<{ platform: string | null; reason: string }>;
	};
	expect(body.imported).toBe(1);
	expect(body.discarded).toContainEqual({
		platform: "openai",
		reason: "unsupported_platform",
	});
	expect(body.discarded).toContainEqual({
		platform: "groq",
		reason: "empty_key",
	});
	const keys = await listApiKeys(db, USER.id, SECRET);
	expect(keys).toHaveLength(1);
	expect(keys[0].platform).toBe("groq");
});

test("import accepts anthropic now that migration 0015 made it a provider", async () => {
	const response = await importRoute.POST(
		postJson("http://localhost/api/keys/import", {
			keys: [{ platform: "anthropic", key: "sk-ant-imported-1" }],
		}),
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as { imported: number };
	expect(body.imported).toBe(1);
});

test("import round-trips an export: export then import restores the keys", async () => {
	await createApiKey(
		db,
		{
			userId: USER.id,
			platform: "groq",
			rawKey: "gsk-round-trip-1",
			keyLabel: "rt",
		},
		SECRET,
	);
	const exported = (await (
		await exportRoute.POST(
			new Request("http://localhost/api/keys/export", { method: "POST" }),
		)
	).json()) as { keys: Array<{ platform: string; key: string }> };
	expect(exported.keys).toHaveLength(1);
	await db
		.prepare("DELETE FROM api_keys WHERE user_id = ?")
		.bind(USER.id)
		.run();
	const response = await importRoute.POST(
		postJson("http://localhost/api/keys/import", exported),
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as { imported: number };
	expect(body.imported).toBe(1);
	const keys = await listApiKeys(db, USER.id, SECRET);
	expect(keys[0].maskedKey).toBe("••••ip-1");
});

test("import with only unsupported keys answers 400 no_valid_keys", async () => {
	const response = await importRoute.POST(
		postJson("http://localhost/api/keys/import", {
			keys: [{ platform: "openai", key: "sk-openai-1" }],
		}),
	);
	expect(response.status).toBe(400);
	const body = (await response.json()) as {
		error: { code: string };
		discarded: Array<{ platform: string | null; reason: string }>;
	};
	expect(body.error.code).toBe("no_valid_keys");
	expect(body.discarded).toEqual([
		{ platform: "openai", reason: "unsupported_platform" },
	]);
});

test("import rejects malformed JSON, a non-object body and more than 500 keys", async () => {
	const malformed = await importRoute.POST(
		new Request("http://localhost/api/keys/import", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{not json",
		}),
	);
	expect(malformed.status).toBe(400);
	const malformedBody = (await malformed.json()) as {
		error: { code: string };
	};
	expect(malformedBody.error.code).toBe("invalid_json");

	const nonObject = await importRoute.POST(
		postJson("http://localhost/api/keys/import", [1, 2, 3]),
	);
	expect(nonObject.status).toBe(400);

	const tooMany = await importRoute.POST(
		postJson("http://localhost/api/keys/import", {
			keys: Array.from({ length: 501 }, (_, i) => ({
				platform: "groq",
				key: `gsk-${i}`,
			})),
		}),
	);
	expect(tooMany.status).toBe(400);
	const tooManyBody = (await tooMany.json()) as {
		error: { code: string };
	};
	expect(tooManyBody.error.code).toBe("too_many_keys");
});

test("import answers 413 when the body exceeds 512 KiB, even without content-length", async () => {
	const big = await importRoute.POST(
		new Request("http://localhost/api/keys/import", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				keys: [{ platform: "groq", key: "x".repeat(600 * 1024) }],
			}),
		}),
	);
	expect(big.status).toBe(413);
	const body = (await big.json()) as { error: { code: string } };
	expect(body.error.code).toBe("body_too_large");
});

test("import answers 403 when the user already holds the 50-key cap", async () => {
	for (let i = 0; i < 50; i += 1) {
		await createApiKey(
			db,
			{
				userId: USER.id,
				platform: "groq",
				rawKey: `gsk-cap-${i}`,
				keyLabel: null,
			},
			SECRET,
		);
	}
	const response = await importRoute.POST(
		postJson("http://localhost/api/keys/import", {
			keys: [{ platform: "groq", key: "gsk-one-more" }],
		}),
	);
	expect(response.status).toBe(403);
	expect(await response.json()).toEqual({
		error: {
			message: "Key limit reached (50 keys per user)",
			type: "limit_reached",
		},
	});
});

test("import without a session answers 401", async () => {
	currentUser = null;
	const response = await importRoute.POST(
		postJson("http://localhost/api/keys/import", { keys: [] }),
	);
	expect(response.status).toBe(401);
});

test("DELETE /api/keys/[id] removes the user's own key and answers 204", async () => {
	const key = await createApiKey(
		db,
		{
			userId: USER.id,
			platform: "groq",
			rawKey: "gsk-delete-me",
			keyLabel: null,
		},
		SECRET,
	);
	const params = { params: Promise.resolve({ id: String(key.id) }) };
	const response = await keyByIdRoute.DELETE(
		new Request(`http://localhost/api/keys/${key.id}`, { method: "DELETE" }),
		params,
	);
	expect(response.status).toBe(204);
	expect(await listApiKeys(db, USER.id, SECRET)).toHaveLength(0);
});

test("DELETE of another user's key answers 204 without deleting it", async () => {
	const key = await createApiKey(
		db,
		{
			userId: OTHER.id,
			platform: "groq",
			rawKey: "gsk-not-mine",
			keyLabel: null,
		},
		SECRET,
	);
	const params = { params: Promise.resolve({ id: String(key.id) }) };
	const response = await keyByIdRoute.DELETE(
		new Request(`http://localhost/api/keys/${key.id}`, { method: "DELETE" }),
		params,
	);
	expect(response.status).toBe(204);
	expect(await listApiKeys(db, OTHER.id, SECRET)).toHaveLength(1);
});

test("key by id validates the id and hides other users' keys", async () => {
	const own = await createApiKey(
		db,
		{
			userId: USER.id,
			platform: "groq",
			rawKey: "gsk-mine-1",
			keyLabel: null,
		},
		SECRET,
	);
	const other = await createApiKey(
		db,
		{
			userId: OTHER.id,
			platform: "groq",
			rawKey: "gsk-theirs-1",
			keyLabel: null,
		},
		SECRET,
	);
	const bad = await keyByIdRoute.GET(
		new Request("http://localhost/api/keys/abc"),
		{ params: Promise.resolve({ id: "abc" }) },
	);
	expect(bad.status).toBe(400);
	const missing = await keyByIdRoute.GET(
		new Request("http://localhost/api/keys/99999"),
		{ params: Promise.resolve({ id: "99999" }) },
	);
	expect(missing.status).toBe(404);
	const theirs = await keyByIdRoute.GET(
		new Request(`http://localhost/api/keys/${other.id}`),
		{ params: Promise.resolve({ id: String(other.id) }) },
	);
	expect(theirs.status).toBe(404);
	const mine = await keyByIdRoute.GET(
		new Request(`http://localhost/api/keys/${own.id}`),
		{ params: Promise.resolve({ id: String(own.id) }) },
	);
	expect(mine.status).toBe(200);
	const mineBody = (await mine.json()) as {
		key: { id: number; platform: string };
	};
	expect(mineBody.key.id).toBe(own.id);
	expect(mineBody.key.platform).toBe("groq");
});
