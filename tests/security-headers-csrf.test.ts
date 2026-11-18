import { beforeEach, expect, mock, test } from "bun:test";
import { invalidOriginResponse, originAllowed } from "../src/lib/csrf";
import type { AppUser } from "../src/lib/types";
import type { MemoryD1 } from "./utils/d1-shim";
import { createParityDatabase } from "./utils/parity-database";

// Security headers + CSRF origin check (M5). Reconstructs the focused
// tests the phase-1 security agent ran in a temporary file: the header
// list in next.config.ts, the origin helper, and its enforcement in a
// route that checks origin before authentication.

test("next.config.ts applies the full security header set to every path", async () => {
	const config = (await import("../next.config")).default;
	const headers = await config.headers?.();
	expect(headers).toHaveLength(1);
	expect(headers?.[0].source).toBe("/:path*");
	const byKey = new Map(
		(headers?.[0].headers ?? []).map((h) => [h.key, h.value]),
	);
	const csp = byKey.get("Content-Security-Policy") ?? "";
	expect(csp).toContain("default-src 'self'");
	expect(csp).toContain("frame-ancestors 'none'");
	expect(csp).toContain("object-src 'none'");
	expect(csp).toContain("upgrade-insecure-requests");
	expect(byKey.get("X-Frame-Options")).toBe("DENY");
	expect(byKey.get("Strict-Transport-Security")).toContain("max-age=63072000");
	expect(byKey.get("Strict-Transport-Security")).toContain("includeSubDomains");
	expect(byKey.get("Strict-Transport-Security")).toContain("preload");
	expect(byKey.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
	expect(byKey.get("Permissions-Policy")).toContain("camera=()");
	expect(byKey.get("Permissions-Policy")).toContain("microphone=()");
	expect(byKey.get("X-Content-Type-Options")).toBe("nosniff");
});

test("originAllowed allows missing and same-origin Origins and rejects the rest", () => {
	const sameOrigin = (origin: string | null) =>
		new Request("http://localhost/api/playground/images", {
			method: "POST",
			...(origin ? { headers: { Origin: origin } } : {}),
		});
	expect(originAllowed(sameOrigin(null))).toBe(true);
	expect(originAllowed(sameOrigin("http://localhost"))).toBe(true);
	expect(originAllowed(sameOrigin("http://localhost:3000"))).toBe(false);
	expect(originAllowed(sameOrigin("https://localhost"))).toBe(false);
	expect(originAllowed(sameOrigin("https://evil.example"))).toBe(false);
	expect(originAllowed(sameOrigin("not a url"))).toBe(false);
});

test("invalidOriginResponse answers 403 with the invalid_origin type", async () => {
	const response = invalidOriginResponse();
	expect(response.status).toBe(403);
	expect(response.headers.get("Cache-Control")).toBe("no-store");
	const body = (await response.json()) as {
		error: { message: string; type: string };
	};
	expect(body.error.type).toBe("invalid_origin");
});

// Enforcement in a real route: POST /api/playground/images checks the
// origin before authentication, so a cross-site request is rejected even
// with a valid session, and a same-origin request reaches auth.
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
// Real session for USER, created per test: the route authenticates
// through the real session module, not a mock. A mock.module for
// ../src/lib/session here would leak into every other test file in the
// same `bun test` run (Bun shares mocked modules across files).
let sessionCookie = "";

mock.module("../src/lib/env", () => ({
	getDb: () => db,
	getEncryptionSecret: () => "csrf-test-secret-0123456789-abcdefghij",
	getImagesBucket: () => ({
		get: async () => null,
		put: async () => {},
		delete: async () => {},
	}),
}));
const { SESSION_COOKIE_NAME, createSession } = await import(
	"../src/lib/session"
);

const { POST } = await import("../src/app/api/playground/images/route");

beforeEach(async () => {
	db = await createParityDatabase();
	await db
		.prepare(
			"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
		)
		.bind(USER.id, USER.name, USER.username, "hash")
		.run();
	const created = await createSession(USER.id);
	sessionCookie = `${SESSION_COOKIE_NAME}=${created.token}`;
});

test("image upload with a cross-site Origin answers 403 before auth runs", async () => {
	const form = new FormData();
	form.append("image", new File(["x"], "a.png", { type: "image/png" }));
	const response = await POST(
		new Request("http://localhost/api/playground/images", {
			method: "POST",
			headers: {
				Origin: "https://evil.example",
				Cookie: sessionCookie,
			},
			body: form,
		}),
	);
	expect(response.status).toBe(403);
	const body = (await response.json()) as {
		error: { type: string };
	};
	expect(body.error.type).toBe("invalid_origin");
});

test("image upload with a same-origin Origin passes the origin check and reaches auth", async () => {
	const form = new FormData();
	form.append("image", new File(["x"], "a.png", { type: "image/png" }));
	// No session cookie: the origin check passed and authentication ran.
	const response = await POST(
		new Request("http://localhost/api/playground/images", {
			method: "POST",
			headers: { Origin: "http://localhost" },
			body: form,
		}),
	);
	// 401, not 403: the origin check passed and authentication ran.
	expect(response.status).toBe(401);
});
