import type { D1Database, PlaygroundSession } from "./types";

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
		.bind(id, userId, "New Session", modelId, now, now)
		.run();
	return {
		id,
		userId,
		name: "New Session",
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
