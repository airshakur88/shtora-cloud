import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyAuthPassword } from "../src/lib/auth-password";

// Seed script (M29): run scripts/seed.mjs as a subprocess against a
// throwaway local SQLite file and check what it leaves behind. The
// password is passed via env so it never appears in the script output.
const ADMIN_USERNAME = "seedadmin";
const ADMIN_PASSWORD = "seed-admin-password-1";

let dir = "";

async function runSeed(
	dbPath: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	const proc = Bun.spawn([process.execPath, "scripts/seed.mjs"], {
		cwd: process.cwd(),
		env: {
			...process.env,
			LOCAL_D1_PATH: dbPath,
			ADMIN_USERNAME,
			ADMIN_PASSWORD,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode: await proc.exited, stdout, stderr };
}

function openDb(dbPath: string): Database {
	return new Database(dbPath, { readonly: true });
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "shtora-seed-test-"));
});

afterEach(async () => {
	// On Windows the seed subprocess can still hold the temp dir for a
	// moment after it exits, so `rm` fails with EBUSY — retry briefly
	// instead of failing the test on cleanup.
	for (let attempt = 0; attempt < 10; attempt += 1) {
		try {
			await rm(dir, { recursive: true, force: true });
			return;
		} catch (error) {
			const code = (error as { code?: string }).code;
			if ((code !== "EBUSY" && code !== "EPERM") || attempt === 9) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
});

// The seed spawns a subprocess that applies 16 migrations and hashes
// the admin password with scrypt. On the slower Windows runner that
// takes longer than Bun's 5s default test timeout, so these tests get
// 60s (the second one runs the seed twice).
test("seed applies every migration and creates the admin with the given password", async () => {
	const dbPath = join(dir, "seed.sqlite");
	const run = await runSeed(dbPath);
	expect(run.exitCode).toBe(0);
	expect(run.stderr).toBe("");
	expect(run.stdout).not.toContain(ADMIN_PASSWORD);
	const db = openDb(dbPath);
	try {
		const providers = db.query("SELECT COUNT(*) AS n FROM providers").get() as {
			n: number;
		};
		expect(providers.n).toBe(50);
		const models = db.query("SELECT COUNT(*) AS n FROM models").get() as {
			n: number;
		};
		expect(models.n).toBe(307);
		const anthropic = db
			.query("SELECT COUNT(*) AS n FROM providers WHERE id = 'anthropic'")
			.get() as { n: number };
		expect(anthropic.n).toBe(1);
		const users = db
			.query("SELECT id, username, role, password_hash FROM user")
			.all() as Array<{
			id: string;
			username: string;
			role: string;
			password_hash: string;
		}>;
		expect(users).toHaveLength(1);
		expect(users[0].username).toBe(ADMIN_USERNAME);
		expect(users[0].role).toBe("admin");
		expect(
			await verifyAuthPassword(ADMIN_PASSWORD, users[0].password_hash),
		).toBe(true);
		expect(
			await verifyAuthPassword("wrong-password", users[0].password_hash),
		).toBe(false);
		const settings = db
			.query("SELECT value FROM settings WHERE key = 'routing_strategy'")
			.get() as { value: string };
		expect(settings.value).toBe("balanced");
		const fallback = db
			.query("SELECT chain_json FROM fallback_config WHERE name = 'default'")
			.get() as { chain_json: string };
		const chain = JSON.parse(JSON.parse(fallback.chain_json)) as {
			chain: Array<{ model: string; platform: string; weight: number }>;
		};
		expect(chain.chain[0]).toEqual({
			model: "gemini-2.5-flash",
			platform: "google",
			weight: 1,
		});
	} finally {
		db.close();
	}
}, 60_000);

test("a second seed run preserves admin-tuned settings and does not duplicate the admin", async () => {
	const dbPath = join(dir, "seed.sqlite");
	const first = await runSeed(dbPath);
	expect(first.exitCode).toBe(0);
	// An admin changes a setting and the fallback chain after the first run.
	const writable = new Database(dbPath);
	try {
		writable
			.prepare("UPDATE settings SET value = 'custom' WHERE key = ?")
			.run("routing_strategy");
		writable
			.prepare("UPDATE fallback_config SET chain_json = ? WHERE name = ?")
			.run(JSON.stringify(JSON.stringify({ strategy: "custom" })), "default");
	} finally {
		writable.close();
	}
	const second = await runSeed(dbPath);
	expect(second.exitCode).toBe(0);
	expect(second.stdout).toContain("1 users already exist");
	const db = openDb(dbPath);
	try {
		const userCount = db.query("SELECT COUNT(*) AS n FROM user").get() as {
			n: number;
		};
		expect(userCount.n).toBe(1);
		// M15: the seed is insert-only now — tuned values survive a re-run.
		const settings = db
			.query("SELECT value FROM settings WHERE key = 'routing_strategy'")
			.get() as { value: string };
		expect(settings.value).toBe("custom");
		const fallback = db
			.query("SELECT chain_json FROM fallback_config WHERE name = 'default'")
			.get() as { chain_json: string };
		expect(JSON.parse(JSON.parse(fallback.chain_json))).toEqual({
			strategy: "custom",
		});
	} finally {
		db.close();
	}
}, 60_000);
