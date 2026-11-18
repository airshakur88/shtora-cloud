import { beforeEach, expect, mock, test } from "bun:test";
import type { AppUser } from "../src/lib/types";
import type { MemoryD1 } from "./utils/d1-shim";
import { createParityDatabase } from "./utils/parity-database";

// Playground image security (M3): magic-byte sniffing, validate-before-
// write, per-user quota, ownership on serve, and the upload rate limit.
// Reconstructs the focused tests the phase-1 security agent ran in a
// temporary file, against the current code.
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
// Real sessions for USER and OTHER, created per test: the routes
// authenticate through the real session module, not a mock. A mock.module
// for ../src/lib/session here would leak into every other test file in the
// same `bun test` run (Bun shares mocked modules across files), which
// broke other test files on the deploy runner: their createSession calls
// hit this file's throwing mock. Keep session unmocked.
let sessionCookie = "";
let otherSessionCookie = "";

// In-memory R2 stand-in.
interface StoredObject {
	bytes: Uint8Array;
	contentType: string;
}
const bucketStore = new Map<string, StoredObject>();
const bucket = {
	async get(key: string) {
		const object = bucketStore.get(key);
		if (!object) return null;
		return {
			body: object.bytes,
			size: object.bytes.length,
			httpMetadata: { contentType: object.contentType },
			arrayBuffer: async () =>
				object.bytes.buffer.slice(
					object.bytes.byteOffset,
					object.bytes.byteOffset + object.bytes.byteLength,
				),
		};
	},
	async put(
		key: string,
		value: unknown,
		options?: { httpMetadata?: { contentType?: string } },
	) {
		const bytes =
			value instanceof Uint8Array
				? value
				: new Uint8Array(await (value as Blob).arrayBuffer());
		bucketStore.set(key, {
			bytes,
			contentType: options?.httpMetadata?.contentType ?? "",
		});
	},
	async delete(key: string) {
		bucketStore.delete(key);
	},
};

mock.module("../src/lib/env", () => ({
	getDb: () => db,
	getEncryptionSecret: () => "images-test-secret-0123456789-abcdefghij",
	getImagesBucket: () => bucket,
}));

const { SESSION_COOKIE_NAME, createSession } = await import(
	"../src/lib/session"
);

const { POST, detectImageMime } = await import(
	"../src/app/api/playground/images/route"
);
const { GET } = await import("../src/app/api/playground/images/[key]/route");
const { imageKeyFromUrl, resolvePlaygroundImages } = await import(
	"../src/lib/playground-images"
);

const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
const WEBP = new Uint8Array([
	0x52, 0x49, 0x46, 0x46, 10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
]);
const GIF = new Uint8Array([
	0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3, 4, 5, 6,
]);
const TEXT = new TextEncoder().encode("hello world, not an image");

function uploadRequest(files: File[], cookie: string = sessionCookie): Request {
	const form = new FormData();
	for (const file of files) form.append("image", file);
	return new Request("http://localhost/api/playground/images", {
		method: "POST",
		headers: { Cookie: cookie },
		body: form,
	});
}

function imageRequest(
	key: string,
	cookie: string | null = sessionCookie,
): Request {
	return new Request(`http://localhost/api/playground/images/${key}`, {
		headers: cookie ? { Cookie: cookie } : {},
	});
}

function pngFile(name = "a.png"): File {
	return new File([PNG as BlobPart], name, { type: "image/png" });
}

async function ownershipRows(userId: string): Promise<number> {
	const row = await db
		.prepare("SELECT COUNT(*) AS n FROM playground_images WHERE user_id = ?")
		.bind(userId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

beforeEach(async () => {
	db = await createParityDatabase();
	bucketStore.clear();
	await db
		.prepare(
			"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
		)
		.bind(USER.id, USER.name, USER.username, "hash")
		.run();
	await db
		.prepare(
			"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
		)
		.bind(OTHER.id, OTHER.name, OTHER.username, "hash")
		.run();
	const userSession = await createSession(USER.id);
	sessionCookie = `${SESSION_COOKIE_NAME}=${userSession.token}`;
	const otherSession = await createSession(OTHER.id);
	otherSessionCookie = `${SESSION_COOKIE_NAME}=${otherSession.token}`;
});

test("detectImageMime sniffs PNG, JPEG, WebP and GIF from magic bytes", () => {
	expect(detectImageMime(PNG)).toBe("image/png");
	expect(detectImageMime(JPEG)).toBe("image/jpeg");
	expect(detectImageMime(WEBP)).toBe("image/webp");
	expect(detectImageMime(GIF)).toBe("image/gif");
	expect(detectImageMime(TEXT)).toBeNull();
	expect(detectImageMime(new Uint8Array([0x89, 0x50]))).toBeNull();
	expect(detectImageMime(new Uint8Array([]))).toBeNull();
	// GIF87a is also a GIF.
	expect(
		detectImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])),
	).toBe("image/gif");
});

test("imageKeyFromUrl accepts only playground URLs with an image extension", () => {
	expect(
		imageKeyFromUrl(
			"/api/playground/images/11111111-1111-4111-8111-111111111111.png",
		),
	).toBe("11111111-1111-4111-8111-111111111111.png");
	expect(imageKeyFromUrl("/api/playground/images/not-a-uuid.png")).toBeNull();
	expect(
		imageKeyFromUrl(
			"/api/playground/images/11111111-1111-4111-8111-111111111111.jpg",
		),
	).toBeNull();
	expect(imageKeyFromUrl("https://example.com/x.png")).toBeNull();
});

test("POST uploads a valid PNG, records ownership and serves it back to the owner", async () => {
	const uploaded = await POST(uploadRequest([pngFile()]));
	expect(uploaded.status).toBe(201);
	expect(uploaded.headers.get("Cache-Control")).toBe("private, no-store");
	const body = (await uploaded.json()) as {
		images: Array<{ url: string; name: string }>;
	};
	expect(body.images).toHaveLength(1);
	expect(body.images[0].name).toBe("a.png");
	const key = body.images[0].url.split("/").pop() ?? "";
	expect(bucketStore.has(key)).toBe(true);
	expect(await ownershipRows(USER.id)).toBe(1);

	const served = await GET(imageRequest(key), {
		params: Promise.resolve({ key }),
	});
	expect(served.status).toBe(200);
	expect(served.headers.get("Content-Type")).toBe("image/png");
	expect(served.headers.get("Cache-Control")).toBe("private, max-age=3600");
	expect(served.headers.get("X-Content-Type-Options")).toBe("nosniff");
	expect(served.headers.get("Vary")).toBe("Cookie");
	expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
});

test("POST rejects a file whose bytes do not match its declared type", async () => {
	const jpegAsPng = new File([JPEG as BlobPart], "fake.png", {
		type: "image/png",
	});
	const response = await POST(uploadRequest([jpegAsPng]));
	expect(response.status).toBe(400);
	const body = (await response.json()) as { error: { message: string } };
	expect(body.error.message).toContain("does not match its declared type");
	expect(bucketStore.size).toBe(0);
	expect(await ownershipRows(USER.id)).toBe(0);
});

test("POST validates every file before writing any, so a bad batch leaves no orphans", async () => {
	const response = await POST(
		uploadRequest([
			pngFile("good.png"),
			new File([TEXT as BlobPart], "bad.png", { type: "image/png" }),
		]),
	);
	expect(response.status).toBe(400);
	expect(bucketStore.size).toBe(0);
	expect(await ownershipRows(USER.id)).toBe(0);
});

test("POST rejects unsupported types, empty uploads, more than 10 files and oversized files", async () => {
	const svg = await POST(
		uploadRequest([new File(["<svg/>"], "x.svg", { type: "image/svg+xml" })]),
	);
	expect(svg.status).toBe(400);

	const empty = await POST(uploadRequest([]));
	expect(empty.status).toBe(400);

	const tooMany = await POST(
		uploadRequest(Array.from({ length: 11 }, (_, i) => pngFile(`${i}.png`))),
	);
	expect(tooMany.status).toBe(400);

	const bigBytes = new Uint8Array(10 * 1024 * 1024 + 1);
	bigBytes.set(PNG);
	const big = await POST(
		uploadRequest([
			new File([bigBytes as BlobPart], "big.png", { type: "image/png" }),
		]),
	);
	expect(big.status).toBe(400);
	const bigBody = (await big.json()) as { error: { message: string } };
	expect(bigBody.error.message).toContain("exceeds the 10 MB limit");
	expect(bucketStore.size).toBe(0);
});

test("GET answers 404 for another user's image, an unknown key and a malformed key", async () => {
	const uploaded = await POST(uploadRequest([pngFile()]));
	const key =
		(
			(await uploaded.json()) as { images: Array<{ url: string }> }
		).images[0].url
			.split("/")
			.pop() ?? "";

	const theirs = await GET(imageRequest(key, otherSessionCookie), {
		params: Promise.resolve({ key }),
	});
	expect(theirs.status).toBe(404);

	const unknown = await GET(
		imageRequest("22222222-2222-4222-8222-222222222222.png"),
		{
			params: Promise.resolve({
				key: "22222222-2222-4222-8222-222222222222.png",
			}),
		},
	);
	expect(unknown.status).toBe(404);
	const malformed = await GET(imageRequest("not-a-key"), {
		params: Promise.resolve({ key: "not-a-key" }),
	});
	expect(malformed.status).toBe(400);
});

test("GET without a session answers 401 and an object without an ownership row answers 404", async () => {
	const key = "33333333-3333-4333-8333-333333333333.png";
	bucketStore.set(key, { bytes: PNG, contentType: "image/png" });
	const unauthenticated = await GET(imageRequest(key, null), {
		params: Promise.resolve({ key }),
	});
	expect(unauthenticated.status).toBe(401);
	// Object exists in the bucket but no playground_images row (e.g. an
	// upload from before migration 0016): not served to anyone.
	const noRow = await GET(imageRequest(key), {
		params: Promise.resolve({ key }),
	});
	expect(noRow.status).toBe(404);
});

test("POST enforces the per-user image count quota", async () => {
	for (let i = 0; i < 100; i += 1) {
		await db
			.prepare(
				"INSERT INTO playground_images (key, user_id, size_bytes, content_type, created_at_ms) VALUES (?, ?, ?, ?, ?)",
			)
			.bind(
				`44444444-4444-4444-8444-${String(i).padStart(12, "0")}.png`,
				USER.id,
				100,
				"image/png",
				Date.now(),
			)
			.run();
	}
	const response = await POST(uploadRequest([pngFile()]));
	expect(response.status).toBe(400);
	const body = (await response.json()) as { error: { message: string } };
	expect(body.error.message).toContain("maximum 100 images per user");
	expect(bucketStore.size).toBe(0);
});

test("POST enforces the per-user 200 MB byte quota", async () => {
	await db
		.prepare(
			"INSERT INTO playground_images (key, user_id, size_bytes, content_type, created_at_ms) VALUES (?, ?, ?, ?, ?)",
		)
		.bind(
			"55555555-5555-4555-8555-555555555555.png",
			USER.id,
			200 * 1024 * 1024,
			"image/png",
			Date.now(),
		)
		.run();
	const response = await POST(uploadRequest([pngFile()]));
	expect(response.status).toBe(400);
	const body = (await response.json()) as { error: { message: string } };
	expect(body.error.message).toContain("maximum 200 MB of images per user");
	expect(bucketStore.size).toBe(0);
});

test("POST enforces the 20 uploads per minute rate limit", async () => {
	for (let i = 0; i < 20; i += 1) {
		const response = await POST(uploadRequest([pngFile(`${i}.png`)]));
		expect(response.status).toBe(201);
	}
	const limited = await POST(uploadRequest([pngFile("21.png")]));
	expect(limited.status).toBe(429);
	expect(limited.headers.get("Retry-After")).not.toBeNull();
	expect(bucketStore.size).toBe(20);
});

test("resolvePlaygroundImages inlines a stored image and throws when it is gone", async () => {
	const key = "66666666-6666-4666-8666-666666666666.png";
	bucketStore.set(key, { bytes: PNG, contentType: "image/png" });
	const resolved = await resolvePlaygroundImages([
		{
			role: "user",
			content: [
				{ type: "text", text: "describe" },
				{
					type: "image_url",
					image_url: { url: `/api/playground/images/${key}` },
				},
			],
		},
	]);
	const part = (
		resolved[0].content as Array<{
			type: string;
			image_url?: { url: string };
		}>
	)[1];
	expect(part.image_url?.url.startsWith("data:image/png;base64,")).toBe(true);

	bucketStore.delete(key);
	let thrown: unknown;
	try {
		await resolvePlaygroundImages([
			{
				role: "user",
				content: [
					{
						type: "image_url",
						image_url: { url: `/api/playground/images/${key}` },
					},
				],
			},
		]);
	} catch (error) {
		thrown = error;
	}
	expect((thrown as Error | undefined)?.name).toBe("PlaygroundImageError");
});
