import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const catalogPath = fileURLToPath(
	new URL("../src/lib/models-catalog.json", import.meta.url),
);
const { providers } = JSON.parse(readFileSync(catalogPath, "utf8"));

let env;
try {
	({ env } = await import("cloudflare:workers"));
} catch {
	console.error(
		"Cloudflare Workers DB binding not found. Run this script in the Workers runtime with a DB binding named DB.",
	);
	process.exit(1);
}

const dbEnv = typeof env === "function" ? env() : env;
if (!dbEnv?.DB) {
	console.error(
		"Cloudflare Workers DB binding not found. Configure a binding named DB before running this script.",
	);
	process.exit(1);
}

const statements = providers.flatMap((provider) =>
	provider.models.map((model) =>
		dbEnv.DB.prepare(
			"UPDATE models SET name = ? WHERE platform = ? AND model_id = ?",
		).bind(model.name, provider.id, model.id),
	),
);
const results = await dbEnv.DB.batch(statements);
const updated = results.reduce(
	(total, result) => total + (result.meta?.changes ?? 0),
	0,
);
console.log(
	`Model name repair complete: ${updated} of ${statements.length} models updated.`,
);
