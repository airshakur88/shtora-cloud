import { env } from "cloudflare:workers";
import type { D1Database, ShtoraEnv } from "./types";

export function getCloudflareEnv(): ShtoraEnv {
	return env as unknown as ShtoraEnv;
}

export function getD1(): D1Database | undefined {
	return getCloudflareEnv().DB;
}

export function getDb(): D1Database {
	const db = getD1();
	if (!db) throw new Error("Database unavailable");
	return db;
}

export function getEncryptionSecret(): string {
	const secret = getCloudflareEnv().ENCRYPTION_SECRET;
	if (!secret || secret.length < 32)
		throw new Error("ENCRYPTION_SECRET is unavailable");
	return secret;
}

export function getImagesBucket(): R2Bucket {
	const bucket = getCloudflareEnv().IMAGES_BUCKET;
	if (!bucket) throw new Error("IMAGES_BUCKET is unavailable");
	return bucket;
}
