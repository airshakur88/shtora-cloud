import handler from "vinext/server/fetch-handler";
import type {
	ScheduledControllerLike,
	ScheduledEnv,
} from "@/lib/jobs/scheduled";
import { handleScheduled } from "@/lib/jobs/scheduled";

/**
 * Custom Worker entrypoint: the vinext app handler plus the cron
 * `scheduled` handler for the Phase 2 jobs (audit §E 2.2/2.4).
 *
 * The `scheduled` handler is attached both to the default export
 * and as a named export: the Workers runtime accepts either form,
 * and keeping both means the dispatch survives whichever shape the
 * vinext bundling preserves.
 */
export default {
	...handler,
	scheduled: (controller: ScheduledControllerLike, env: ScheduledEnv) =>
		handleScheduled(controller, env),
};

export async function scheduled(
	controller: ScheduledControllerLike,
	env: ScheduledEnv,
): Promise<void> {
	await handleScheduled(controller, env);
}
