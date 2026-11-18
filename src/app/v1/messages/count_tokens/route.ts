import { handleNativeMessages } from "@/lib/anthropic-route";

export async function POST(request: Request): Promise<Response> {
	return handleNativeMessages(request, "count_tokens");
}
