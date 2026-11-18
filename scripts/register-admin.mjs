#!/usr/bin/env node
/**
 * Simple script to create an admin user in the Shtora Cloud D1 database.
 *
 * Usage: bun run scripts/register-admin.mjs
 *
 * Environment variables:
 *   ADMIN_USERNAME - Username for admin account (default: admin)
 *   ADMIN_PASSWORD - Password for admin account (generated if not set)
 *
 * Must be run in vinext runtime with D1 binding configured, or with miniflare.
 */

// scrypt parameters - must match src/lib/password.ts
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SALT_BYTES = 16;

// Convert Uint8Array to hex string
function toHex(bytes) {
	let hex = "";
	for (const byte of bytes) {
		hex += byte.toString(16).padStart(2, "0");
	}
	return hex;
}

// Hash password using scrypt
async function hashPassword(password) {
	const scryptModule = await import("scrypt-js");
	const scryptSync =
		scryptModule.syncScrypt || scryptModule.default?.syncScrypt;

	if (!scryptSync) {
		throw new Error("scrypt-js syncScrypt not available");
	}

	const salt = new Uint8Array(SALT_BYTES);
	if (typeof crypto !== "undefined" && crypto.getRandomValues) {
		crypto.getRandomValues(salt);
	} else {
		const nodeCrypto = await import("node:crypto");
		nodeCrypto.getRandomValues(salt);
	}

	const hash = scryptSync(
		new TextEncoder().encode(password),
		salt,
		SCRYPT_N,
		SCRYPT_R,
		SCRYPT_P,
		SCRYPT_KEYLEN,
	);

	const saltHex = toHex(salt);
	const hashHex = toHex(hash);

	return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${saltHex}$${hashHex}`;
}

/**
 * Get D1 database instance from vinext bindings
 */
function getD1Database() {
	try {
		const { env } = require("cloudflare:workers");
		return (typeof env === "function" ? env() : env).DB;
	} catch {
		return null;
	}
}

/**
 * Get local database for development
 */
async function getLocalDatabase() {
	try {
		const nodeSqlite = require("node:sqlite");
		const Database = nodeSqlite.Database;
		const dbPath = process.env.LOCAL_D1_PATH || ":memory:";
		return new Database(dbPath);
	} catch {
		try {
			const betterSqlite = require("better-sqlite3");
			const dbPath = process.env.LOCAL_D1_PATH || ":memory:";
			return new betterSqlite.Database(dbPath);
		} catch {
			throw new Error(
				"No local D1 database available. Install node:sqlite or better-sqlite3, or run in vinext runtime.",
			);
		}
	}
}

async function main() {
	const adminUsername = process.env.ADMIN_USERNAME || "admin";

	console.log(`\n=== Shtora Cloud Admin Registration ===\n`);
	console.log(`Username: ${adminUsername}`);

	// Get password or generate one
	let adminPassword = process.env.ADMIN_PASSWORD;
	if (!adminPassword || adminPassword.trim().length === 0) {
		adminPassword = crypto.randomUUID().slice(0, 12);
		console.log(`Password: ${adminPassword}`);
		console.log("   Generated password will not be shown again!");
	} else {
		console.log(`Password: *** (from ADMIN_PASSWORD)`);
	}

	// Get D1 database
	let db;
	let isLocal = false;

	try {
		db = getD1Database();
	} catch {
		db = null;
	}

	if (!db) {
		db = await getLocalDatabase();
		isLocal = true;
	}

	if (!db) {
		console.error("\n❌ Could not access D1 database");
		console.error("   Run in vinext runtime or with miniflare");
		process.exit(1);
	}

	// Check if user already exists
	let existingUser = null;

	if (isLocal) {
		existingUser = db
			.prepare("SELECT id FROM user WHERE username = ?")
			.get(adminUsername);
	} else {
		const result = await db
			.prepare("SELECT id FROM user WHERE username = ?")
			.bind(adminUsername)
			.first();
		existingUser = result || null;
	}

	if (existingUser) {
		console.log(`\nℹ️  Admin user "${adminUsername}" already exists`);
		process.exit(0);
	}

	// Hash password
	const passwordHash = await hashPassword(adminPassword);
	const userId = crypto.randomUUID();

	const insertSql =
		"INSERT INTO user (id, name, username, role, password_hash) VALUES (?, ?, ?, ?, ?)";
	const insertValues = [userId, "Admin", adminUsername, "admin", passwordHash];

	console.log("\nCreating admin user...");

	if (isLocal) {
		db.prepare(insertSql).run(...insertValues);
	} else {
		await db
			.prepare(insertSql)
			.bind(...insertValues)
			.run();
	}

	console.log(`\n✅ Admin user registered successfully!`);
	console.log(`   User ID: ${userId}`);
	console.log(`   Username: ${adminUsername}`);
	console.log(`   Role: admin`);
	console.log("\n   Password has been set. Login with your credentials.\n");
}

main().catch((err) => {
	console.error("\n❌ Registration failed:", err.message);
	process.exit(1);
});
