import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryD1 } from "./d1-shim";
export async function createParityDatabase(): Promise<MemoryD1> {
	const db = new MemoryD1();
	const initialSchema = readFileSync(
		resolve(process.cwd(), "migrations/0001_initial_schema.sql"),
		"utf8",
	);
	db.exec(initialSchema);
	db.exec(
		readFileSync(
			resolve(process.cwd(), "migrations/0002_backend_parity.sql"),
			"utf8",
		),
	);
	db.exec(
		readFileSync(
			resolve(process.cwd(), "migrations/0003_usage_metrics.sql"),
			"utf8",
		),
	);
	db.exec(
		readFileSync(
			resolve(process.cwd(), "migrations/0004_usage_metrics_backfill.sql"),
			"utf8",
		),
	);
	db.exec(
		readFileSync(
			resolve(process.cwd(), "migrations/0005_anthropic_catalog.sql"),
			"utf8",
		),
	);
	return db;
}
