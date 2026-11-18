import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryD1 } from "./d1-shim";
export async function createParityDatabase(): Promise<MemoryD1> {
	const db = new MemoryD1();
	for (const migration of [
		"0001_initial_schema.sql",
		"0002_backend_parity.sql",
		"0003_usage_metrics.sql",
		"0004_usage_metrics_backfill.sql",
		"0005_anthropic_catalog.sql",
		"0006_fix_model_names.sql",
		"0007_playground_sessions.sql",
		"0008_user_access_keys.sql",
		"0009_remove_aclide.sql",
		"0010_providers.sql",
		"0011_clean_model_names_a.sql",
		"0012_clean_model_names_b.sql",
		"0013_clean_model_names_c.sql",
		"0014_clean_model_names_d.sql",
		"0015_anthropic_provider.sql",
		"0016_playground_image_ownership.sql",
	]) {
		db.exec(
			readFileSync(resolve(process.cwd(), `migrations/${migration}`), "utf8"),
		);
	}
	return db;
}
