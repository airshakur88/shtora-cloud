import { nativeModels } from "@/lib/anthropic-models";

export async function GET(
	request: Request,
	context: { params: Promise<{ model: string[] }> },
): Promise<Response> {
	const { model } = await context.params;
	return nativeModels(request, model.join("/"));
}
