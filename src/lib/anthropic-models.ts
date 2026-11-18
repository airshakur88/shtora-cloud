import { getDb } from "./env";
import {
	anthropicError,
	getInferenceUser,
	InferenceHttpError,
} from "./inference-http";

export async function nativeModels(
	request: Request,
	modelId?: string,
): Promise<Response> {
	try {
		const db = getDb();
		await getInferenceUser(request, db, true);
		const result = await db
			.prepare(
				"SELECT platform, model_id, name, context_window, max_output_tokens FROM models WHERE enabled = 1 ORDER BY platform, model_id",
			)
			.all<{
				platform: string;
				model_id: string;
				name: string;
				context_window: number;
				max_output_tokens: number | null;
			}>();
		// Native model shape, per the Anthropic Models API. Three fields
		// below look wrong at first glance and are intentional:
		// - `id` is `platform/model_id`, not the bare vendor id: ids are
		//   namespaced because the same model id exists on several
		//   providers. The bare model id still resolves on retrieve.
		// - `created_at` is the epoch sentinel. Anthropic specifies the
		//   epoch value for exactly this case: "May be set to an epoch
		//   value if the release date is unknown." D1 stores no vendor
		//   release date (models.created_at is the catalog import time,
		//   not the release), so the sentinel stays instead of a
		//   fabricated date.
		// - `capabilities: null` is a valid Anthropic value (the field is
		//   nullable). D1 has no per-model capability map beyond
		//   supports_tools/supports_vision, so null means unknown rather
		//   than an invented capability set. `lifecycle: "active"` holds
		//   because only enabled rows are listed; `line`,
		//   `deprecated_at` and `retires_at` are null for the same
		//   no-data reason.
		const data = result.results.map((row) => ({
			type: "model",
			id: `${row.platform}/${row.model_id}`,
			display_name: row.name,
			created_at: "1970-01-01T00:00:00Z",
			capabilities: null,
			max_input_tokens: row.context_window || null,
			max_tokens: row.max_output_tokens,
			line: null,
			lifecycle: "active",
			deprecated_at: null,
			retires_at: null,
		}));
		if (modelId !== undefined) {
			const selected =
				data.find((model) => model.id === modelId) ??
				data.find(
					(model) => model.id.slice(model.id.indexOf("/") + 1) === modelId,
				);
			return selected
				? Response.json(selected)
				: anthropicError("Model not found", 404, "not_found_error");
		}
		const query = new URL(request.url).searchParams;
		const limit = Number(query.get("limit") ?? 20);
		const after = query.get("after_id");
		const before = query.get("before_id");
		if (
			!Number.isInteger(limit) ||
			limit < 1 ||
			limit > 1000 ||
			(after && before)
		)
			throw new InferenceHttpError("Invalid model pagination");
		let start = 0;
		let end = data.length;
		if (after || before) {
			const index = data.findIndex((model) => model.id === (after || before));
			if (index < 0) throw new InferenceHttpError("Unknown model cursor");
			if (after) start = index + 1;
			else {
				end = index;
				start = Math.max(0, end - limit);
			}
		}
		const lifecycle = [
			...query.getAll("lifecycle"),
			...query.getAll("lifecycle[]"),
		];
		if (
			lifecycle.some(
				(value) => !["active", "deprecated", "retired"].includes(value),
			)
		)
			throw new InferenceHttpError("Invalid lifecycle");
		const page =
			lifecycle.length && !lifecycle.includes("active")
				? []
				: data.slice(start, Math.min(end, start + limit));
		return Response.json({
			data: page,
			has_more: before
				? start > 0
				: start + page.length < end && page.length > 0,
			first_id: page[0]?.id ?? null,
			last_id: page.at(-1)?.id ?? null,
		});
	} catch (error) {
		if (error instanceof InferenceHttpError)
			return anthropicError(error.message, error.status, error.type);
		return anthropicError("Internal error", 500, "api_error");
	}
}
