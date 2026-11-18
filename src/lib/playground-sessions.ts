import type { D1Database, PlaygroundSession } from "./types";

/** Name given to a session until its first message renames it. */
export const DEFAULT_SESSION_NAME = "New Session";

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
			 ORDER BY updated_at_ms DESC`,
		)
		.bind(userId)
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

export async function updateSession(
	db: D1Database,
	sessionId: string,
	userId: string,
	updates: { name?: string | null; modelId?: string | null },
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
