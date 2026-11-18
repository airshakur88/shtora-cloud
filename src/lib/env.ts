import { env } from "cloudflare:workers";
import type { D1Database, ShtoraEnv } from "./types";

export function getDb(): D1Database {
	const db = (env as unknown as ShtoraEnv).DB;
	if (!db) throw new Error("Database unavailable");
	return db;
}

export function getEncryptionSecret(): string {
	const secret = (env as unknown as ShtoraEnv).ENCRYPTION_SECRET;
	if (!secret || secret.length < 32)
		throw new Error("ENCRYPTION_SECRET is unavailable");
	return secret;
}

export function getImagesBucket(): R2Bucket {
	const bucket = (env as unknown as ShtoraEnv).IMAGES_BUCKET;
	if (!bucket) throw new Error("IMAGES_BUCKET is unavailable");
	return bucket;
}
