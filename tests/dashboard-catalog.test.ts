import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { MemoryD1 } from "./utils/d1-shim";
import { createParityDatabase } from "./utils/parity-database";

const SECRET = "catalog-test-secret-0123456789-abcdefghijklmnopqrstuvwxyz";
let db: MemoryD1;
let sessionToken = "";

mock.module("../src/lib/env", () => ({
	getDb: () => db,
	getEncryptionSecret: () => SECRET,
}));

// Dynamic import needed because env.ts depends on cloudflare:workers
// which is only available under the mock at runtime.
const { GET } = await import("../src/app/api/dashboard/catalog/route");

function sha256Hex(input: string): Promise<string> {
	const digest = crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(input),
	);
	return digest.then((d) =>
		Array.from(new Uint8Array(d), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join(""),
	);
}

function randomHex(bytes: number): string {
	const arr = crypto.getRandomValues(new Uint8Array(bytes));
	return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

interface CatalogResponse {
	providers: Array<{
		id: string;
		name: string;
		globalKeys: number;
		personalKeys: number;
	}>;
	models: Array<{
		id: string;
		name: string;
		platform: string;
		enabled: boolean;
		supportsTools: boolean;
		supportsVision: boolean;
		contextWindow: number;
		globalKeyCount: number;
		personalKeyCount: number;
		description?: string;
		members?: string[];
	}>;
}

beforeEach(async () => {
	db = await createParityDatabase();

	// Fixtures replace the migrated catalog: the catalog route tests pin
	// exact models, so the 303 catalog rows must not compete with them.
	// The providers table stays — the route reads provider names from it.
	await db.prepare("DELETE FROM models").run();

	await db
		.prepare(
			"INSERT INTO user (id,name,username,password_hash) VALUES ('test-user','Test User','testuser','unused')",
		)
		.run();
	await db
		.prepare(
			"INSERT INTO user (id,name,username,password_hash) VALUES ('other-user','Other User','otheruser','unused')",
		)
		.run();

	// Enabled key for test-user on platform 'groq'
	await db
		.prepare(
			"INSERT INTO api_keys (user_id,platform,encrypted_key,iv,auth_tag,enabled,unified_token) VALUES ('test-user','groq','enc','iv1','tag1',1,'tok-a')",
		)
		.run();
	// Disabled key for other-user on platform 'groq' — per spec: global counts regardless of enabled
	await db
		.prepare(
			"INSERT INTO api_keys (user_id,platform,encrypted_key,iv,auth_tag,enabled,unified_token) VALUES ('other-user','groq','enc','iv2','tag2',0,'tok-b')",
		)
		.run();

	// Models for platforms that have keys (canonical id: llama-4 → shtora/llama-4)
	await db
		.prepare(
			"INSERT INTO models (platform,model_id,name,context_window,supports_tools,supports_vision,enabled) VALUES ('groq','llama-4','Llama 4',128000,1,1,1)",
		)
		.run();
	// gpt-4o also on groq
	await db
		.prepare(
			"INSERT INTO models (platform,model_id,name,context_window,supports_tools,supports_vision,enabled) VALUES ('groq','gpt-4o','GPT-4o',200000,1,1,1)",
		)
		.run();
	// Disabled model — should not appear
	await db
		.prepare(
			"INSERT INTO models (platform,model_id,name,context_window,supports_tools,supports_vision,enabled) VALUES ('groq','gpt-3.5','GPT-3.5',16000,1,0,0)",
		)
		.run();

	// Create session for test-user
	const now = Date.now();
	sessionToken = randomHex(32);
	const tokenHash = await sha256Hex(sessionToken);
	const sessionRow = crypto.randomUUID();
	await db
		.prepare(
			"INSERT INTO shtora_auth_sessions (id,token_hash,user_id,created_at_ms,expires_at_ms) VALUES (?,?,?,?,?)",
		)
		.bind(sessionRow, tokenHash, "test-user", now, now + 86_400_000)
		.run();
});

afterEach(() => {
	db.close();
});

afterAll(() => {
	mock.restore();
});

function authRequest(): Request {
	return new Request("https://dashboard.test/api/dashboard/catalog", {
		method: "GET",
		headers: {
			Cookie: `__Host-shtora.session=${sessionToken}`,
		},
	});
}

async function getCatalog(): Promise<CatalogResponse> {
	const response = await GET(authRequest());
	expect(response.status).toBe(200);
	return (await response.json()) as CatalogResponse;
}

test("returns 401 when no session cookie", async () => {
	const request = new Request("https://dashboard.test/api/dashboard/catalog", {
		method: "GET",
	});
	const response = await GET(request);
	expect(response.status).toBe(401);
	const body = (await response.json()) as {
		error: { message: string; type: string };
	};
	expect(body.error).toBeDefined();
	expect(body.error.type).toBe("auth_error");
});

test("personal counts reflect only current user's ENABLED keys", async () => {
	const body = await getCatalog();
	const providers = body.providers;

	const groq = providers.find((p) => p.id === "groq");
	expect(groq).toBeDefined();

	// test-user has 1 enabled groq key
	expect(groq?.personalKeys).toBe(1);
});

test("global counts aggregate ALL users' keys regardless of enabled", async () => {
	const body = await getCatalog();
	const providers = body.providers;

	const groq = providers.find((p) => p.id === "groq");
	expect(groq).toBeDefined();

	// groq: test-user enabled (1) + other-user disabled (1) = 2 total keys
	expect(groq?.globalKeys).toBe(2);
});

test("model rows include globalKeyCount and personalKeyCount from their platform", async () => {
	const body = await getCatalog();
	const models = body.models;

	// Model IDs are deduplicated and prefixed with shtora/
	const llama4 = models.find((m) => m.id === "shtora/llama-4");
	const gpt4o = models.find((m) => m.id === "shtora/gpt-4o");
	expect(llama4).toBeDefined();
	expect(gpt4o).toBeDefined();

	// groq: global=2 (test-user enabled + other-user disabled), personal=1 (test-user enabled only)
	expect(llama4?.globalKeyCount).toBe(2);
	expect(llama4?.personalKeyCount).toBe(1);
	expect(gpt4o?.globalKeyCount).toBe(2);
	expect(gpt4o?.personalKeyCount).toBe(1);
});

test("providers array includes entries from catalog", async () => {
	const body = await getCatalog();
	const providers = body.providers;

	// Should include at least the providers that exist in the catalog
	expect(providers.length).toBeGreaterThan(0);

	// Verify a few known catalog providers are present
	const ids = providers.map((p) => p.id);
	expect(ids).toContain("groq");

	// Each provider should have a name from the catalog
	for (const provider of providers) {
		expect(typeof provider.name).toBe("string");
		expect(provider.name.length).toBeGreaterThan(0);
	}
});

test("no foreign user identifiers leaked in response", async () => {
	const response = await GET(authRequest());
	expect(response.status).toBe(200);
	const rawJson = await response.text();

	// The response should not contain usernames or unified tokens
	expect(rawJson).not.toContain("testuser");
	expect(rawJson).not.toContain("otheruser");
	expect(rawJson).not.toContain("Test User");
	expect(rawJson).not.toContain("Other User");
	expect(rawJson).not.toContain("tok-a");
	expect(rawJson).not.toContain("tok-b");
});

test("disabled models are excluded from response", async () => {
	const body = await getCatalog();
	const models = body.models;

	// gpt-3.5 was inserted with enabled=0, should not appear
	expect(models.find((m) => m.id === "shtora/gpt-3.5")).toBeUndefined();
	// gpt-4o was enabled, should appear
	expect(models.find((m) => m.id === "shtora/gpt-4o")).toBeDefined();
});

test("response includes Cache-Control: private, no-store", async () => {
	const response = await GET(authRequest());
	expect(response.status).toBe(200);
	expect(response.headers.get("Cache-Control")).toBe("private, no-store");
});

test("excludes shtora/auto as an ordinary model and lists virtual routers", async () => {
	// Upstream auto row must never appear as an ordinary model.
	await db
		.prepare(
			"INSERT INTO models (platform,model_id,name,context_window,supports_tools,supports_vision,enabled) VALUES ('groq','auto','Upstream Auto',32768,1,1,1)",
		)
		.run();
	// Kilo free-router row must appear as shtora/kilo-free, never shtora/free.
	await db
		.prepare(
			"INSERT INTO models (platform,model_id,name,context_window,supports_tools,supports_vision,enabled) VALUES ('kilo','kilo-auto/free','Kilo Auto Free',32768,1,1,1)",
		)
		.run();
	// A coding member so shtora/coding has a routable member.
	await db
		.prepare(
			"INSERT INTO models (platform,model_id,name,context_window,supports_tools,supports_vision,enabled) VALUES ('groq','qwen3-coder-plus','Qwen3 Coder Plus',32768,1,1,1)",
		)
		.run();
	// An auto member so shtora/auto has a routable member.
	await db
		.prepare(
			"INSERT INTO models (platform,model_id,name,context_window,supports_tools,supports_vision,enabled) VALUES ('groq','qwen3-8-max','Qwen3 8 Max',32768,1,1,1)",
		)
		.run();

	const body = await getCatalog();
	const ids = body.models.map((m) => m.id);

	expect(ids).not.toContain("shtora/free");
	expect(ids).toContain("shtora/kilo-free");
	// shtora/auto exists exactly once — as the virtual router, not as an
	// ordinary model entry for the upstream "auto" rows.
	expect(ids.filter((id) => id === "shtora/auto")).toHaveLength(1);

	const coding = body.models.find((m) => m.id === "shtora/coding");
	expect(coding).toBeDefined();
	expect(coding?.members).toContain("qwen3-coder-plus");
	expect(coding?.name).toBe("Shtora Coding");

	const auto = body.models.find((m) => m.id === "shtora/auto");
	expect(auto).toBeDefined();
	expect(auto?.name).toBe("Shtora Auto");
	expect(auto?.members).toContain("qwen3-8-max");
	expect(auto?.members).not.toContain("auto");
});
