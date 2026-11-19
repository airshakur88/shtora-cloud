import { beforeEach, expect, mock, test } from "bun:test";
import type { MemoryD1 } from "./utils/d1-shim";
import { createParityDatabase } from "./utils/parity-database";

// Cron endpoints: 503 without a secret, 401 on a wrong secret, 200
// with the right one. The env module is mocked the way the other
// route tests do it; the secret is mutable so all three states are
// covered against the same handlers.
let db: MemoryD1;
let cronSecret: string | undefined = "test-cron-secret";

mock.module("../src/lib/env", () => ({
	getDb: () => db,
	getEncryptionSecret: () =>
		"test-secret-0123456789-abcdefghijklmnopqrstuvwxyz",
	getImagesBucket: () => {
		throw new Error("IMAGES_BUCKET is unavailable in this test");
	},
}));

// The cron secret lives in its own module (see src/lib/cron-env.ts)
// so this mock cannot collide with the `env` mocks other files use.
mock.module("../src/lib/cron-env", () => ({
	getCronSecret: () => cronSecret,
}));

const validateRoute = await import(
	"../src/app/api/cron/validate-catalog/route"
);
const probeRoute = await import("../src/app/api/cron/probe-keys/route");

function post(url: string, secret: string | null): Request {
	return new Request(url, {
		method: "POST",
		headers: secret === null ? {} : { Authorization: `Bearer ${secret}` },
	});
}

beforeEach(async () => {
	db = await createParityDatabase();
	cronSecret = "test-cron-secret";
});

test("validate-catalog: 503 when CRON_SECRET is not configured", async () => {
	cronSecret = undefined;
	const response = await validateRoute.POST(
		post("https://shtora.test/api/cron/validate-catalog", "anything"),
	);
	expect(response.status).toBe(503);
	const body = (await response.json()) as {
		error: { message: string; type: string };
	};
	expect(body.error.message).toMatch(/CRON_SECRET/);
});

test("validate-catalog: 401 on a wrong secret, and with no header", async () => {
	const wrong = await validateRoute.POST(
		post("https://shtora.test/api/cron/validate-catalog", "nope"),
	);
	expect(wrong.status).toBe(401);
	const missing = await validateRoute.POST(
		post("https://shtora.test/api/cron/validate-catalog", null),
	);
	expect(missing.status).toBe(401);
});

test("validate-catalog: 200 with the right secret, returns the summary", async () => {
	const response = await validateRoute.POST(
		post("https://shtora.test/api/cron/validate-catalog", "test-cron-secret"),
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		checked: number;
		suspected: number;
		skipped: number;
	};
	expect(typeof body.checked).toBe("number");
	expect(typeof body.suspected).toBe("number");
	expect(typeof body.skipped).toBe("number");
});

test("probe-keys: 503 without a secret, 401 on a wrong secret", async () => {
	cronSecret = undefined;
	const unconfigured = await probeRoute.POST(
		post("https://shtora.test/api/cron/probe-keys", "anything"),
	);
	expect(unconfigured.status).toBe(503);
	cronSecret = "test-cron-secret";
	const wrong = await probeRoute.POST(
		post("https://shtora.test/api/cron/probe-keys", "nope"),
	);
	expect(wrong.status).toBe(401);
});

test("probe-keys: 200 with the right secret, returns the summary", async () => {
	const response = await probeRoute.POST(
		post("https://shtora.test/api/cron/probe-keys", "test-cron-secret"),
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		checked: number;
		healthy: number;
		suspended: number;
	};
	expect(body).toMatchObject({ checked: 0, healthy: 0, suspended: 0 });
});
