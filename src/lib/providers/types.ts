import type { ChatCompletionRequest, ChatMessage, ChatTool } from "../types";

export interface UpstreamChatInput {
	platform: string;
	modelId: string;
	apiKey: string;
	baseUrl: string | null;
	messages: ChatMessage[];
	stream: boolean;
	temperature?: number;
	maxTokens?: number;
	tools?: ChatTool[];
	stop?: string | string[];
	toolChoice?: ChatCompletionRequest["tool_choice"];
	parallelToolCalls?: boolean;
}
