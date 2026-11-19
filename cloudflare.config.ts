import { bindings, defineConfig, defineWorker, triggers } from "cf/config";
// Cron schedules must stay in sync with CATALOG_VALIDATION_CRON /
// KEY_PROBE_CRON in src/lib/jobs/scheduled.ts (the dispatcher matches
// on the literal string). They are literals here because this file is
// loaded as plain Node ESM: it cannot import the `@/`-aliased job
// modules, whose extensionless imports Node cannot resolve.

export default defineConfig({
	worker: defineWorker({
		name: "shtora-cloud",
		entrypoint: "./worker/index.ts",
		triggers: [
			triggers.scheduled({ schedule: "0 3 * * *" }),
			triggers.scheduled({ schedule: "*/30 * * * *" }),
		],
		compatibilityDate: "2026-11-12",
		compatibilityFlags: ["nodejs_compat"],
		observability: {
			logs: {
				enabled: true,
				invocationLogs: true,
				persist: true,
			},
		},
		assets: {
			htmlHandling: "none",
			notFoundHandling: "none",
			runWorkerFirst: ["/*", "!/_next/static/*", "!/*/_next/static/*"],
		},
		env: {
			ENCRYPTION_SECRET: bindings.secret(),
			ASSETS: bindings.assets(),
			IMAGES: bindings.images(),
			DB: bindings.d1({
				id: "5a731b04-a5ac-4897-91cd-bd212e80699b",
				name: "shtora",
			}),
			IMAGES_BUCKET: bindings.r2({ name: "shtora-images" }),
		},
	}),
});
