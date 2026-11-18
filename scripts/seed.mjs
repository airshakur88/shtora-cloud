/**
 * Seeds the D1 database by applying migrations/*.sql, then ensures the
 * default fallback chain, default settings, and an initial admin user.
 *
 * The models/providers catalog lives in the migrations now (migration 0010
 * carries the providers table and the 303 catalog models) — there is no JSON
 * catalog to read anymore, so a fresh database seeded by this script matches
 * production exactly: apply the migrations, nothing else to copy.
 *
 * Environment variables:
 *   ADMIN_USERNAME - Username for initial admin (default: admin)
 *   ADMIN_PASSWORD - Password for initial admin (generated if not set)
 *   LOCAL_D1_PATH  - Path of the local SQLite file (default: ./.dev-d1.sqlite)
 *
 * Run locally with:
 *   bun run scripts/seed.mjs
 * Run against the remote D1 (Workers runtime with a DB binding named DB):
 *   bun run scripts/seed.mjs  (inside `vite dev --remote`, or any runtime
 *   where `cloudflare:workers` resolves)
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { hashAuthPassword } from "../src/lib/auth-password.ts";

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

function listMigrationFiles() {
	const dir = fileURLToPath(new URL("../migrations", import.meta.url));
	return readdirSync(dir)
		.filter((file) => file.endsWith(".sql"))
		.sort()
		.map((file) => ({
			name: file,
			sql: readFileSync(`${dir}/${file}`, "utf8"),
		}));
}

/**
 * Split a migration file into single statements for D1 `batch()`.
 * Tracks string literals, comments, and a BEGIN/CASE keyword stack so the
 * `;` inside trigger bodies (migration 0003) and CASE expressions never
 * split a statement. Tested against every migration file: applying the
 * split statements yields the same schema and rows as whole-file exec.
 */
function splitSqlStatements(sql) {
	const statements = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let inLineComment = false;
	let inBlockComment = false;
	const stack = [];
	const isWordChar = (ch) => /[A-Za-z0-9_$]/.test(ch);
	for (let i = 0; i < sql.length; i++) {
		const ch = sql[i];
		const next = sql[i + 1] ?? "";
		if (inLineComment) {
			current += ch;
			if (ch === "\n") inLineComment = false;
			continue;
		}
		if (inBlockComment) {
			current += ch;
			if (ch === "*" && next === "/") {
				current += next;
				i++;
				inBlockComment = false;
			}
			continue;
		}
		if (inSingle) {
			current += ch;
			if (ch === "'") {
				if (next === "'") {
					current += next;
					i++;
				} else {
					inSingle = false;
				}
			}
			continue;
		}
		if (inDouble) {
			current += ch;
			if (ch === '"') inDouble = false;
			continue;
		}
		if (ch === "-" && next === "-") {
			inLineComment = true;
			current += ch;
			continue;
		}
		if (ch === "/" && next === "*") {
			inBlockComment = true;
			current += ch;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			current += ch;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			current += ch;
			continue;
		}
		const wordStart = i === 0 || !isWordChar(sql[i - 1]);
		if (wordStart) {
			const rest = sql.slice(i).toUpperCase();
			for (const [keyword, kind] of [
				["BEGIN", "begin"],
				["CASE", "case"],
				["END", "end"],
			]) {
				if (
					rest.startsWith(keyword) &&
					!isWordChar(sql[i + keyword.length] ?? "")
				) {
					if (kind === "end") stack.pop();
					else stack.push(kind);
					break;
				}
			}
		}
		if (ch === ";" && stack.length === 0) {
			if (current.trim()) statements.push(current.trim());
			current = "";
			continue;
		}
		current += ch;
	}
	if (current.trim()) statements.push(current.trim());
	return statements;
}

/**
 * Get the D1 database from the Workers runtime, if this script runs inside
 * one (dynamic import: plain `bun` cannot resolve `cloudflare:workers`).
 */
async function getWorkersDatabase() {
	try {
		const { env } = await import("cloudflare:workers");
		const resolved = typeof env === "function" ? env() : env;
		return resolved?.DB ?? null;
	} catch {
		return null;
	}
}

async function applyMigrations(db, isLocal) {
	const files = listMigrationFiles();
	// Re-running the seed used to re-apply every migration, and some of
	// them add columns without IF NOT EXISTS (e.g. 0003), so a second run
	// died with "duplicate column name". Applied migrations are recorded
	// in seed_migrations and skipped on later runs; the migration files
	// themselves are never edited. A migration is only recorded after it
	// applies cleanly, so a failed run retries it next time.
	await run(
		db,
		isLocal,
		`CREATE TABLE IF NOT EXISTS seed_migrations (
			name TEXT PRIMARY KEY,
			applied_at TEXT NOT NULL
		)`,
	);
	let applied = 0;
	for (const file of files) {
		const row = await first(
			db,
			isLocal,
			"SELECT name FROM seed_migrations WHERE name = ?",
			file.name,
		);
		if (row) {
			console.log(`  Skipped ${file.name} (already applied)`);
			continue;
		}
		if (isLocal) {
			db.exec(file.sql);
		} else {
			const statements = splitSqlStatements(file.sql).map((statement) =>
				db.prepare(statement),
			);
			await db.batch(statements);
		}
		await run(
			db,
			isLocal,
			"INSERT INTO seed_migrations (name, applied_at) VALUES (?, ?)",
			file.name,
			new Date().toISOString(),
		);
		console.log(`  Applied ${file.name}`);
		applied += 1;
	}
	return applied;
}

async function run(db, isLocal, sql, ...values) {
	if (isLocal) return db.prepare(sql).run(...values);
	return db
		.prepare(sql)
		.bind(...values)
		.run();
}

async function first(db, isLocal, sql, ...values) {
	if (isLocal) return db.prepare(sql).get(...values);
	return db
		.prepare(sql)
		.bind(...values)
		.first();
}

async function main() {
	console.log("🌱 Seeding Shtora Cloud database...\n");

	const adminUsername = process.env.ADMIN_USERNAME ?? "admin";
	const adminPassword = process.env.ADMIN_PASSWORD;

	// Workers binding first, local SQLite file otherwise.
	let db = await getWorkersDatabase();
	let isLocal = false;
	if (!db) {
		const dbPath = process.env.LOCAL_D1_PATH || "./.dev-d1.sqlite";
		db = new Database(dbPath);
		isLocal = true;
		console.log(`Using local D1 database (${dbPath})`);
	}

	await applyMigrations(db, isLocal);

	// Insert-only: nunca sobrescrever um fallback_config já existente.
	// Rodar o seed contra um banco em produção não pode resetar ajustes
	// feitos por admin.
	const fallbackJson = JSON.stringify(JSON.stringify(DEFAULT_FALLBACK_CHAIN));
	await run(
		db,
		isLocal,
		`INSERT INTO fallback_config (name, chain_json, is_default)
    VALUES (?, ?, ?)
    ON CONFLICT(name) DO NOTHING`,
		"default",
		fallbackJson,
		1,
	);

	for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
		// Insert-only: settings existentes (ajustadas por admin) são
		// preservadas; só as ausentes recebem o valor padrão.
		await run(
			db,
			isLocal,
			`INSERT INTO settings (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO NOTHING`,
			key,
			String(value),
		);
	}

	// Create admin user if table is empty
	const userRow = await first(
		db,
		isLocal,
		"SELECT COUNT(*) AS count FROM user",
	);
	const userCount = userRow?.count ?? 0;

	if (userCount === 0) {
		const generatedPassword =
			!adminPassword || adminPassword.trim().length === 0;
		const finalPassword = generatedPassword
			? crypto.randomUUID().slice(0, 12)
			: adminPassword;

		const passwordHash = await hashAuthPassword(finalPassword);
		const userId = crypto.randomUUID();

		await run(
			db,
			isLocal,
			"INSERT INTO user (id, name, username, role, password_hash) VALUES (?, ?, ?, ?, ?)",
			userId,
			"Admin",
			adminUsername,
			"admin",
			passwordHash,
		);

		console.log(`✅ Admin user created: ${adminUsername}`);
		if (generatedPassword) {
			console.log(`🔑 Generated password: ${finalPassword}`);
			console.log("   Save it now — it won't be shown again!");
		}
	} else {
		console.log(`ℹ️  ${userCount} users already exist, skipping admin creation`);
	}

	// Count models and providers from the migrated catalog
	const modelRow = await first(
		db,
		isLocal,
		"SELECT COUNT(*) AS count FROM models",
	);
	const providerRow = await first(
		db,
		isLocal,
		"SELECT COUNT(*) AS count FROM providers",
	);
	console.log(
		`\n✅ Seeded ${providerRow?.count ?? 0} providers and ${modelRow?.count ?? 0} model rows from migrations`,
	);
	console.log("\n🎉 Database seeding complete!");
}

// Run the script
main().catch((err) => {
	console.error("❌ Seeding failed:", err.message);
	process.exit(1);
});
