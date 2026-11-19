import { afterAll, beforeAll, expect, test } from "bun:test";
import type { MemoryD1 } from "./utils/d1-shim";
import { createParityDatabase } from "./utils/parity-database";

// Migration 0019 (Fase 2 R8/R10, Fase 4 R25/B2): modality + suspect
// columns on models, suspension columns on api_keys, modality backfill
// for non-chat models, and the devstral-2512 tools fix.
let db: MemoryD1;
beforeAll(async () => {
	db = await createParityDatabase();
});
afterAll(() => {
	db.close();
});

interface TableInfoRow {
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | number | null;
}

async function columns(table: string): Promise<Map<string, TableInfoRow>> {
	const rows = await db
		.prepare(`PRAGMA table_info(${table})`)
		.all<TableInfoRow>();
	return new Map(rows.results.map((row) => [row.name, row]));
}

test("0019 adds the modality, suspect and suspension columns", async () => {
	const models = await columns("models");
	expect(models.get("modality")).toMatchObject({
		type: "TEXT",
		notnull: 1,
		dflt_value: "'chat'",
	});
	expect(models.has("suspect_reason")).toBe(true);
	expect(models.has("suspect_since")).toBe(true);
	const keys = await columns("api_keys");
	expect(keys.has("suspended_until_ms")).toBe(true);
	expect(keys.has("suspension_reason")).toBe(true);
});

test("0019 marks exactly the non-chat models from the catalog", async () => {
	const rows = await db
		.prepare(
			"SELECT platform, model_id, modality FROM models WHERE modality != 'chat' ORDER BY platform, model_id",
		)
		.all<{ platform: string; model_id: string; modality: string }>();
	expect(rows.results).toEqual([
		{
			platform: "cloudflare",
			model_id: "@cf/black-forest-labs/flux-1-schnell",
			modality: "image",
		},
		{
			platform: "cloudflare",
			model_id: "@cf/myshell-ai/melotts",
			modality: "audio",
		},
		{
			platform: "cloudflare",
			model_id: "@cf/stabilityai/stable-diffusion-xl-base-1.0",
			modality: "image",
		},
		{
			platform: "electronhub",
			model_id: "gemini-3.8-flash-lite-tts",
			modality: "audio",
		},
		{
			platform: "electronhub",
			model_id: "gemini-3.8-flash-tts",
			modality: "audio",
		},
		{ platform: "electronhub", model_id: "humain-tts", modality: "audio" },
		{ platform: "freeai", model_id: "kokoro", modality: "audio" },
		{
			platform: "google",
			model_id: "gemini-2.5-flash-preview-tts",
			modality: "audio",
		},
	]);
	// The backfill only reclassifies; it adds and removes no rows.
	const total = await db
		.prepare("SELECT COUNT(*) AS n FROM models")
		.all<{ n: number }>();
	expect(total.results[0]?.n).toBe(307);
});

test("0019 leaves vision, omni, audio-understanding and guard models as chat", async () => {
	const rows = await db
		.prepare(
			`SELECT model_id, modality FROM models WHERE
			 (platform = 'electronhub' AND model_id IN ('gemma-4-31b-aura-large-v1.1', 'devstral-2512'))
			 OR (platform = 'airforce' AND model_id = 'voxtral-small-2507')
			 OR (platform = 'xkiro' AND model_id = 'qwen/qwen3-omni-flash:free')
			 OR (platform = 'ovh' AND model_id = 'Qwen3Guard-Gen-8B')
			 OR (platform = 'cloudflare' AND model_id = '@cf/meta/llama-3.2-11b-vision-instruct')`,
		)
		.all<{ model_id: string; modality: string }>();
	expect(rows.results).toHaveLength(6);
	for (const row of rows.results) expect(row.modality).toBe("chat");
});

test("0019 fixes supports_tools on both Devstral Small 2 rows (B2)", async () => {
	const rows = await db
		.prepare(
			`SELECT model_id, supports_tools FROM models
			 WHERE platform = 'electronhub'
			 AND model_id IN ('devstral-2512', 'labs-devstral-small-2512')`,
		)
		.all<{ model_id: string; supports_tools: number }>();
	expect(rows.results).toEqual([
		{ model_id: "devstral-2512", supports_tools: 1 },
		{ model_id: "labs-devstral-small-2512", supports_tools: 1 },
	]);
});
