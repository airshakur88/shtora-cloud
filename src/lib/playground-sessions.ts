import { canonicalModelId } from "./model-canonical";
import type { D1Database, PlaygroundSession } from "./types";
import { isVirtualRouter } from "./virtual-routers";

/** Name given to a session until its first message renames it. */
export const DEFAULT_SESSION_NAME = "New Session";

/**
 * Maximum number of sessions a single list call returns. There is no
 * cursor pagination on this endpoint yet, so the cap keeps one user's
 * session list bounded no matter how many sessions they accumulate.
 */
export const MAX_SESSIONS_LISTED = 100;

/** Maximum length of an auto-generated session title, in characters. */
export const SESSION_TITLE_MAX_LENGTH = 50;

/**
 * Derives a one-line session title from the first user message.
 * Returns null when there is no usable text (empty or attachments-only).
 * Long titles are cut at the last word boundary within the limit so no
 * word is split in half; a single over-long word is hard-cut instead.
 */
export function deriveSessionTitle(content: string): string | null {
	const firstLine = content
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!firstLine) return null;
	const text = firstLine.replace(/\s+/g, " ").trim();
	if (!text) return null;
	if (text.length <= SESSION_TITLE_MAX_LENGTH) return text;
	const cut = text.slice(0, SESSION_TITLE_MAX_LENGTH);
	const lastSpace = cut.lastIndexOf(" ");
	const head = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
	return `${head}…`;
}

export async function createSession(
	db: D1Database,
	userId: string,
	modelId: string,
): Promise<PlaygroundSession> {
	const id = crypto.randomUUID();
	const now = Date.now();
	await db
		.prepare(
			`INSERT INTO playground_sessions (id, user_id, name, model_id, created_at_ms, updated_at_ms)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.bind(id, userId, DEFAULT_SESSION_NAME, modelId, now, now)
		.run();
	return {
		id,
		userId,
		name: DEFAULT_SESSION_NAME,
		modelId,
		createdAtMs: now,
		updatedAtMs: now,
	};
}

/**
 * Lists a user's sessions, newest first, capped at MAX_SESSIONS_LISTED.
 * Order is stable across calls: `updated_at_ms DESC` with `id DESC` as
 * the tiebreaker for sessions updated within the same millisecond.
 */
export async function listSessions(
	db: D1Database,
	userId: string,
): Promise<PlaygroundSession[]> {
	const result = await db
		.prepare(
			`SELECT id, user_id AS userId, name, model_id AS modelId,
				 created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs
			 FROM playground_sessions
			 WHERE user_id = ?
			 ORDER BY updated_at_ms DESC, id DESC
			 LIMIT ?`,
		)
		.bind(userId, MAX_SESSIONS_LISTED)
		.all<{
			id: string;
			userId: string;
			name: string;
			modelId: string;
			createdAtMs: number;
			updatedAtMs: number;
		}>();
	return result.results ?? [];
}

export async function deleteSession(
	db: D1Database,
	sessionId: string,
	userId: string,
): Promise<boolean> {
	const result = await db
		.prepare(
			`DELETE FROM playground_sessions
			 WHERE id = ? AND user_id = ?`,
		)
		.bind(sessionId, userId)
		.run();
	return result.meta.changes > 0;
}

/**
 * True when `modelId` names a model the router can serve: an enabled row
 * in `models` (by canonical id, so `shtora/<canonical>`,
 * `platform/model_id` and the bare canonical id all match the same row)
 * or one of the curated virtual routers (`shtora/auto`, `shtora/coding`,
 * ...). Disabled rows do not count.
 */
export async function modelExists(
	db: D1Database,
	modelId: string,
): Promise<boolean> {
	const value = modelId.trim();
	if (!value) return false;
	if (isVirtualRouter(value)) return true;
	const canonical = canonicalModelId(value);
	const rows = await db
		.prepare("SELECT model_id FROM models WHERE enabled = 1")
		.all<{ model_id: string }>();
	return (rows.results ?? []).some(
		(row) => canonicalModelId(row.model_id) === canonical,
	);
}

export async function updateSession(
	db: D1Database,
	sessionId: string,
	userId: string,
	// Omit a field to keep its current value. Callers must reject an
	// empty string before calling: it is a client bug, not "keep".
	updates: { name?: string; modelId?: string },
): Promise<PlaygroundSession | null> {
	const existing = await db
		.prepare(
			`SELECT id, user_id AS userId, name, model_id AS modelId,
				 created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs
			 FROM playground_sessions
			 WHERE id = ? AND user_id = ?`,
		)
		.bind(sessionId, userId)
		.first<PlaygroundSession>();
	if (!existing) return null;
	const name = updates.name ?? existing.name;
	const modelId = updates.modelId ?? existing.modelId;
	const now = Date.now();
	await db
		.prepare(
			`UPDATE playground_sessions
			 SET name = ?, model_id = ?, updated_at_ms = ?
			 WHERE id = ? AND user_id = ?`,
		)
		.bind(name, modelId, now, sessionId, userId)
		.run();
	return { ...existing, name, modelId, updatedAtMs: now };
}

export async function getSession(
	db: D1Database,
	sessionId: string,
	userId: string,
): Promise<PlaygroundSession | null> {
	const result = await db
		.prepare(
			`SELECT id, user_id AS userId, name, model_id AS modelId,
				 created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs
			 FROM playground_sessions
			 WHERE id = ? AND user_id = ?`,
		)
		.bind(sessionId, userId)
		.first<{
			id: string;
			userId: string;
			name: string;
			modelId: string;
			createdAtMs: number;
			updatedAtMs: number;
		}>();
	if (!result) return null;
	return result as PlaygroundSession;
}
