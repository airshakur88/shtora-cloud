import { bindings, defineConfig, defineWorker } from "cf/config";

export default defineConfig({
	worker: defineWorker({
		name: "shtora-cloud",
		entrypoint: "vinext/server/fetch-handler",
		compatibilityDate: "2026-11-12",
		compatibilityFlags: ["nodejs_compat"],
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
