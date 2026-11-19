import { expect, test } from "bun:test";
import { createAccessKey } from "../src/lib/access-keys";
import {
	getInferenceUser,
	InferenceHttpError,
} from "../src/lib/inference-http";
import type { MemoryD1 } from "./utils/d1-shim";
import { createParityDatabase } from "./utils/parity-database";

async function setupUser(db: MemoryD1): Promise<void> {
	await db
		.prepare(
			"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
		)
		.bind("u1", "Test User", "testuser", "hash")
		.run();
}

function bearerRequest(token: string): Request {
	return new Request("http://localhost/v1/chat/completions", {
		method: "POST",
		headers: { Authorization: `Bearer ${token}` },
	});
}

async function expectUnauthorized(promise: Promise<unknown>): Promise<void> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(InferenceHttpError);
		expect((error as InferenceHttpError).status).toBe(401);
		return;
	}
	throw new Error("Expected getInferenceUser to reject with 401");
}

test("a token without the ska- prefix logs not_an_api_key without the token", async () => {
	const db = await createParityDatabase();
	try {
		await setupUser(db);
		const token = "not-an-api-key";
		const warnings: unknown[] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => {
			warnings.push(args[0]);
		};
		try {
			await expectUnauthorized(getInferenceUser(bearerRequest(token), db));
		} finally {
			console.warn = originalWarn;
		}
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatchObject({
			event: "v1_auth_failed",
			reason: "not_an_api_key",
			length: token.length,
		});
		expect(JSON.stringify(warnings)).not.toContain(token);
	} finally {
		db.close();
	}
});

test("an unknown ska- key logs invalid_api_key without the token", async () => {
	const db = await createParityDatabase();
	try {
		await setupUser(db);
		const token = `ska-${"0".repeat(64)}`;
		const warnings: unknown[] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => {
			warnings.push(args[0]);
		};
		try {
			await expectUnauthorized(getInferenceUser(bearerRequest(token), db));
		} finally {
			console.warn = originalWarn;
		}
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatchObject({
			event: "v1_auth_failed",
			reason: "invalid_api_key",
		});
		expect(JSON.stringify(warnings)).not.toContain(token);
	} finally {
		db.close();
	}
});

test("a valid access key resolves its owner", async () => {
	const db = await createParityDatabase();
	try {
		await setupUser(db);
		const { apiKey } = await createAccessKey(db, "u1", { name: "test" });
		expect(apiKey.startsWith("ska-")).toBe(true);
		const user = await getInferenceUser(bearerRequest(apiKey), db);
		expect(user.id).toBe("u1");
		expect(user.username).toBe("testuser");
	} finally {
		db.close();
	}
});

test("a valid access key resolves its owner through x-api-key in native mode", async () => {
	const db = await createParityDatabase();
	try {
		await setupUser(db);
		const { apiKey } = await createAccessKey(db, "u1", { name: "native" });
		const request = new Request("http://localhost/v1/messages", {
			method: "POST",
			headers: { "x-api-key": apiKey },
		});
		const user = await getInferenceUser(request, db, true);
		expect(user.id).toBe("u1");
	} finally {
		db.close();
	}
});
