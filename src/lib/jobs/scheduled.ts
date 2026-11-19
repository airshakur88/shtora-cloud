import type { D1Database } from "@/lib/types";
import { runCatalogValidation } from "./catalog-validation";
import { runKeyProbe } from "./key-probe";

/** Daily catalog validation, 03:00 UTC. */
export const CATALOG_VALIDATION_CRON = "0 3 * * *";
/** Key probe, every 30 minutes. */
export const KEY_PROBE_CRON = "*/30 * * * *";

/** Structural subset of the Workers `ScheduledController`. */
export interface ScheduledControllerLike {
	readonly cron: string;
	readonly scheduledTime: number;
}

/** Bindings the jobs need; extra bindings on the real env are ignored. */
export interface ScheduledEnv {
	DB?: D1Database;
	ENCRYPTION_SECRET?: string;
}

/**
 * Cron-trigger dispatcher for the Phase 2 jobs (audit §E 2.2/2.4),
 * called from the Worker's `scheduled` handler in `worker/index.ts`.
 * The trigger itself is the auth — Cloudflare only fires these for
 * the schedules in `cloudflare.config.ts` — so there is no
 * `CRON_SECRET` check here; that secret is for the HTTP endpoints
 * (`/api/cron/*`), used by an external scheduler instead.
 */
export async function handleScheduled(
	controller: ScheduledControllerLike,
	env: ScheduledEnv,
): Promise<void> {
	if (!env.DB) throw new Error("Database unavailable");
	if (!env.ENCRYPTION_SECRET)
		throw new Error("ENCRYPTION_SECRET is unavailable");
	if (controller.cron === CATALOG_VALIDATION_CRON) {
		const summary = await runCatalogValidation(env.DB, {
			encryptionSecret: env.ENCRYPTION_SECRET,
		});
		console.error(
			JSON.stringify({
				event: "scheduled",
				cron: controller.cron,
				job: "catalog_validation",
				...summary,
			}),
		);
		return;
	}
	if (controller.cron === KEY_PROBE_CRON) {
		const summary = await runKeyProbe(env.DB, {
			encryptionSecret: env.ENCRYPTION_SECRET,
		});
		console.error(
			JSON.stringify({
				event: "scheduled",
				cron: controller.cron,
				job: "key_probe",
				...summary,
			}),
		);
		return;
	}
	console.error(
		JSON.stringify({
			event: "scheduled",
			cron: controller.cron,
			job: "unknown",
			skipped: true,
		}),
	);
}
