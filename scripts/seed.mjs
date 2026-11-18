/**
 * Seeds the D1 database with the models catalog, default config, and initial admin user.
 *
 * This script uses vinext's D1 bindings directly (via cloudflare:workers) and does
 * NOT require wrangler CLI or miniflare. It's designed to run in the vinext runtime
 * or as a standalone script with a provided D1 database binding.
 *
 * Environment variables:
 *   ADMIN_USERNAME - Username for initial admin (default: admin)
 *   ADMIN_PASSWORD - Password for initial admin (generated if not set)
 *   DB_NAME - Database name for local D1 (if using local binding)
 *
 * For local development with miniflare, use:
 *   vinext dev --remote if true  (for remote D1)
 *   bun run scripts/seed.mjs
 */

import { hashAuthPassword } from "../src/lib/auth-password.ts";

// Read the source catalog used by the application and seed script.
async function loadModelsCatalog() {
	const { readFileSync } = await import("node:fs");
	const { fileURLToPath } = await import("node:url");
	const catalogPath = fileURLToPath(
		new URL("../src/lib/models-catalog.json", import.meta.url),
	);
	return JSON.parse(readFileSync(catalogPath, "utf-8"));
}

// Default fallback chain configuration
const DEFAULT_FALLBACK_CHAIN = {
	strategy: "balanced",
	chain: [
		{ model: "gemini-2.5-flash", platform: "google", weight: 1.0 },
		{ model: "llama-3.1-70b-instruct", platform: "groq", weight: 0.9 },
		{
			model: "llama-4-maverick-17b-128e-instruct",
			platform: "cerebras",
			weight: 0.8,
		},
		{ model: "mistral-large-latest", platform: "mistral", weight: 0.7 },
	],
	fallback_on: ["429", "500", "502", "503", "504", "timeout"],
	max_retries: 3,
	timeout_ms: 15000,
};

// Default settings
const DEFAULT_SETTINGS = {
	routing_strategy: "balanced",
	routing_provider_moment_attribution: true,
	score_window_days: 7,
	score_half_life_days: 2,
	cooldown_escalation_seconds: JSON.stringify([
		90, 120, 300, 600, 1800, 3600, 14400, 86400,
	]),
};

// Convert capabilities array to SQL flags
function capabilitiesToFlags(capabilities = []) {
	const c = new Set(capabilities);
	return {
		supports_tools: c.has("tools") ? 1 : 0,
		supports_vision: c.has("vision") ? 1 : 0,
		supports_json_mode: c.has("json_mode") ? 1 : 0,
	};
}

// Determine tier from model ID
const TIER1_PATTERNS = [
	"gpt-5",
	"gemini-2.5-pro",
	"deepseek-v4-pro",
	"qwen-3-coder-480b",
	"mistral-large",
	"llama-4-maverick",
	"claude-4",
	"grok-4",
];

function tierOf(modelId, supportsFunctions) {
	const id = modelId.toLowerCase();
	if (TIER1_PATTERNS.some((pattern) => id.includes(pattern))) return 1;
	if (supportsFunctions) return 2;
	return 3;
}

/**
 * Get D1 database instance from vinext bindings
 * Works in both local (miniflare) and remote environments
 */
function getD1Database() {
	try {
		// Try vinext/Workers runtime first
		const { env } = require("cloudflare:workers");
		return (typeof env === "function" ? env() : env).DB;
	} catch {
		// Not in Workers runtime
		return null;
	}
}

/**
 * Get D1 database for local testing with better-sqlite3 or node:sqlite
 */
async function getLocalDatabase() {
	try {
		const nodeSqlite = require("node:sqlite");
		const Database = nodeSqlite.Database;
		// Use in-memory DB or local file
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
	console.log("🌱 Seeding Shtora Cloud database...\n");

	const adminUsername = process.env.ADMIN_USERNAME ?? "admin";
	const adminPassword = process.env.ADMIN_PASSWORD;

	// Get D1 database
	let db;
	let isLocal = false;

	try {
		db = getD1Database();
	} catch {
		db = null;
	}

	if (!db) {
		// Try local database for development
		db = await getLocalDatabase();
		isLocal = true;
		if (isLocal) {
			console.log("Using local D1 database (memory)");
		}
	}

	if (!db) {
		console.error("❌ Could not access D1 database");
		console.error("   Run in vinext runtime or with miniflare");
		process.exit(1);
	}

	// Load models catalog
	let catalog;
	try {
		catalog = await loadModelsCatalog();
	} catch (err) {
		console.error("❌ Failed to load models catalog:", err.message);
		process.exit(1);
	}

	// Seed models
	const modelStatements = [];
	let seeded = 0;
	const rankByTier = { 1: 0, 2: 0, 3: 0 };

	for (const provider of catalog.providers || []) {
		for (const model of provider.models || []) {
			const flags = capabilitiesToFlags(model.capabilities || []);
			const tier = tierOf(model.id, model.supportsFunctions);
			rankByTier[tier] += 1;

			const statement = {
				sql: `INSERT INTO models
        (platform, model_id, name, context_window, supports_tools, supports_vision,
         supports_json_mode, tier, intelligence_rank)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(platform, model_id) DO UPDATE SET
         context_window = excluded.context_window,
         supports_tools = excluded.supports_tools,
         supports_vision = excluded.supports_vision,
         supports_json_mode = excluded.supports_json_mode,
         tier = excluded.tier,
         intelligence_rank = excluded.intelligence_rank,
         updated_at = datetime('now')`,
				values: [
					provider.id,
					model.id,
					model.name,
					model.contextWindow,
					Number(flags.supports_tools),
					Number(flags.supports_vision),
					Number(flags.supports_json_mode),
					tier,
					rankByTier[tier],
				],
			};

			modelStatements.push(statement);
			seeded += 1;
		}
	}

	for (const stmt of modelStatements) {
		if (isLocal) {
			db.prepare(stmt.sql).run(...stmt.values);
		} else {
			await db
				.prepare(stmt.sql)
				.bind(...stmt.values)
				.run();
		}
	}

	const fallbackJson = JSON.stringify(JSON.stringify(DEFAULT_FALLBACK_CHAIN));

	const fallbackStmt = {
		sql: `INSERT INTO fallback_config (name, chain_json, is_default)
    VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      chain_json = excluded.chain_json,
      updated_at = datetime('now')`,
		values: ["default", fallbackJson, 1],
	};

	if (isLocal) {
		db.prepare(fallbackStmt.sql).run(...fallbackStmt.values);
	} else {
		await db
			.prepare(fallbackStmt.sql)
			.bind(...fallbackStmt.values)
			.run();
	}

	for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
		const settingStmt = {
			sql: `INSERT INTO settings (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = datetime('now')`,
			values: [key, String(value)],
		};

		if (isLocal) {
			db.prepare(settingStmt.sql).run(...settingStmt.values);
		} else {
			await db
				.prepare(settingStmt.sql)
				.bind(...settingStmt.values)
				.run();
		}
	}

	// Create admin user if table is empty
	let userCount = 0;

	if (isLocal) {
		const result = db.prepare("SELECT COUNT(*) AS count FROM user").get();
		userCount = result.count || 0;
	} else {
		const result = await db
			.prepare("SELECT COUNT(*) AS count FROM user")
			.first();
		userCount = result?.count ?? 0;
	}

	if (userCount === 0) {
		const generatedPassword =
			!adminPassword || adminPassword.trim().length === 0;
		const finalPassword = generatedPassword
			? crypto.randomUUID().slice(0, 12)
			: adminPassword;

		const passwordHash = await hashAuthPassword(finalPassword);
		const userId = crypto.randomUUID();

		const adminSql =
			"INSERT INTO user (id, name, username, role, password_hash) VALUES (?, ?, ?, ?, ?)";
		const adminValues = [userId, "Admin", adminUsername, "admin", passwordHash];

		if (isLocal) {
			db.prepare(adminSql).run(...adminValues);
		} else {
			await db
				.prepare(adminSql)
				.bind(...adminValues)
				.run();
		}

		console.log(`✅ Admin user created: ${adminUsername}`);
		if (generatedPassword) {
			console.log(`🔑 Generated password: ${finalPassword}`);
			console.log("   Save it now — it won't be shown again!");
		}
	} else {
		console.log(`ℹ️  ${userCount} users already exist, skipping admin creation`);
	}

	// Count models
	let count = 0;
	if (isLocal) {
		const result = db.prepare("SELECT COUNT(*) AS count FROM models").get();
		count = result.count || 0;
	} else {
		const result = await db
			.prepare("SELECT COUNT(*) AS count FROM models")
			.first();
		count = result?.count ?? 0;
	}

	console.log(
		`\n✅ Seeded ${seeded} model rows from models-catalog.json (total in DB: ${count})`,
	);
	console.log("\n🎉 Database seeding complete!");
}

// Run the script
main().catch((err) => {
	console.error("❌ Seeding failed:", err.message);
	process.exit(1);
});
