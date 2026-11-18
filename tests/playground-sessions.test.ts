import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	createSession,
	deriveSessionTitle,
	listSessions,
	MAX_SESSIONS_LISTED,
	modelExists,
	updateSession,
} from "../src/lib/playground-sessions";
import type { MemoryD1 } from "./utils/d1-shim";
import { createParityDatabase } from "./utils/parity-database";

const USER_ID = "playground-user-1";

let db: MemoryD1;
beforeAll(async () => {
	db = await createParityDatabase();
	await db
		.prepare(
			"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
		)
		.bind(USER_ID, "Test User", "playgrounduser", "hash")
		.run();
	await db
		.prepare(
			"INSERT INTO user (id, name, username, password_hash) VALUES (?, ?, ?, ?)",
		)
		.bind("playground-user-2", "Other User", "playgroundother", "hash")
		.run();
});
afterAll(() => {
	db.close();
});

async function insertSession(
	id: string,
	userId: string,
	updatedAtMs: number,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO playground_sessions (id, user_id, name, model_id, created_at_ms, updated_at_ms)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.bind(id, userId, "Session", "google/gemini-2.5-flash", 1, updatedAtMs)
		.run();
}

test("listSessions caps at MAX_SESSIONS_LISTED, newest first", async () => {
	for (let index = 0; index < MAX_SESSIONS_LISTED + 5; index++) {
		await insertSession(
			`cap-${String(index).padStart(3, "0")}`,
			USER_ID,
			index,
		);
	}
	// A session from another user must not count toward this user's cap.
	await insertSession("cap-other-user", "playground-user-2", 1_000_000);
	const sessions = await listSessions(db, USER_ID);
	expect(sessions).toHaveLength(MAX_SESSIONS_LISTED);
	expect(sessions[0]?.id).toBe(`cap-${MAX_SESSIONS_LISTED + 4}`);
	expect(sessions.at(-1)?.id).toBe("cap-005");
	expect(sessions.some((session) => session.id === "cap-other-user")).toBe(
		false,
	);
});

test("listSessions order is stable when updated_at_ms ties", async () => {
	await insertSession("tie-aaaa", USER_ID, 9_999_999);
	await insertSession("tie-bbbb", USER_ID, 9_999_999);
	const sessions = await listSessions(db, USER_ID);
	expect(sessions[0]?.id).toBe("tie-bbbb");
	expect(sessions[1]?.id).toBe("tie-aaaa");
});

test("modelExists accepts catalog ids in every accepted form", async () => {
	expect(await modelExists(db, "agnes-2.0-flash")).toBe(true);
	expect(await modelExists(db, "google/gemini-2.5-flash")).toBe(true);
	expect(await modelExists(db, "shtora/gemini-2-5-flash")).toBe(true);
	expect(await modelExists(db, "shtora/auto")).toBe(true);
	expect(await modelExists(db, "shtora/coding")).toBe(true);
});

test("modelExists rejects unknown, empty and disabled models", async () => {
	expect(await modelExists(db, "no-such-model-xyz")).toBe(false);
	expect(await modelExists(db, "")).toBe(false);
	expect(await modelExists(db, "   ")).toBe(false);
	await db
		.prepare(
			`INSERT INTO models (platform, model_id, name, context_window, enabled)
			 VALUES (?, ?, ?, ?, ?)`,
		)
		.bind("testprov", "disabled-model", "Disabled Model", 4096, 0)
		.run();
	expect(await modelExists(db, "disabled-model")).toBe(false);
});

test("updateSession keeps fields that are omitted", async () => {
	const session = await createSession(db, USER_ID, "google/gemini-2.5-flash");
	const kept = await updateSession(db, session.id, USER_ID, {});
	expect(kept?.name).toBe(session.name);
	expect(kept?.modelId).toBe(session.modelId);
	const renamed = await updateSession(db, session.id, USER_ID, {
		name: "Renamed",
	});
	expect(renamed?.name).toBe("Renamed");
	expect(renamed?.modelId).toBe(session.modelId);
});

test("returns short text unchanged", () => {
	expect(deriveSessionTitle("Explain recursion")).toBe("Explain recursion");
});

test("returns null for empty or whitespace-only content", () => {
	expect(deriveSessionTitle("")).toBeNull();
	expect(deriveSessionTitle("   \n  ")).toBeNull();
});

test("uses only the first non-empty line", () => {
	expect(deriveSessionTitle("First line\nSecond line")).toBe("First line");
	expect(deriveSessionTitle("\n  \nFirst real line\nSecond")).toBe(
		"First real line",
	);
});

test("collapses inner whitespace", () => {
	expect(deriveSessionTitle("  write   a   poem  ")).toBe("write a poem");
});

test("cuts long titles at a word boundary with an ellipsis", () => {
	const title = deriveSessionTitle(
		"Write a detailed explanation of how the router picks providers",
	);
	expect(title).toBe("Write a detailed explanation of how the router…");
	expect(title?.endsWith("…")).toBe(true);
	expect(title?.length).toBeLessThanOrEqual(51);
});

test("hard-cuts a single over-long word", () => {
	const word = "a".repeat(60);
	expect(deriveSessionTitle(word)).toBe(`${"a".repeat(50)}…`);
});

test("keeps a title of exactly 50 characters unchanged", () => {
	const text = "x".repeat(50);
	expect(deriveSessionTitle(text)).toBe(text);
});
