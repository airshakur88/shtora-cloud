export interface D1Result<T> {
	success: true;
	results: T[];
	meta: {
		changes: number;
		last_row_id: number;
		rows_read: number;
		rows_written: number;
	};
}
export type D1Value = string | number | bigint | boolean | null;

export interface D1PreparedStatement {
	bind(...values: D1Value[]): D1PreparedStatement;
	first<T = Record<string, unknown>>(): Promise<T | null>;
	all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
	run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}
export interface D1Database {
	prepare(sql: string): D1PreparedStatement;
	batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export interface ShtoraEnv {
	DB?: D1Database;
	ENCRYPTION_SECRET?: string;
	CRON_SECRET?: string;
	IMAGES_BUCKET?: R2Bucket;
}

export type UserRole = "user" | "admin";

export interface AppUser {
	id: string;
	name: string;
	username: string;
	role: UserRole;
	passwordHash: string;
	createdAt: string;
	updatedAt: string;
}

export interface AppUserRecord {
	id: string;
	name: string;
	username: string;
	role: string;
	password_hash: string;
	created_at: string;
	updated_at: string;
}

export interface ShtoraSession {
	id: string;
	tokenHash: string;
	userId: string;
	createdAtMs: number;
	expiresAtMs: number;
}

export type HealthStatus = "healthy" | "rate_limited" | "invalid" | "error";

export interface ApiKey {
	id: number;
	userId: string;
	platform: string;
	keyLabel: string | null;
	enabled: number;
	lastHealthCheckStatus: HealthStatus | null;
	lastHealthCheckAt: string | null;
	createdAt: string;
	updatedAt: string;
	rpmLimit: number | null;
	tpmLimit: number | null;
	rpdLimit: number | null;
	tpdLimit: number | null;
	encryptedKey: string;
	iv: string;
	authTag: string;
	baseUrl: string | null;
}

export interface ApiKeyRecord {
	id: number;
	user_id: string;
	platform: string;
	key_label: string | null;
	encrypted_key: string;
	iv: string;
	auth_tag: string;
	base_url: string | null;
	enabled: number;
	rpm_limit: number | null;
	tpm_limit: number | null;
	rpd_limit: number | null;
	tpd_limit: number | null;
	created_at: string;
	updated_at: string;
	last_health_check_at: string | null;
	last_health_check_status: string | null;
	/** Temporary suspension (migration 0019): epoch ms, or null. */
	suspended_until_ms: number | null;
	suspension_reason: string | null;
}

export interface CreateApiKeyRequest {
	platform: string;
	rawKey?: string;
	keyLabel?: string | null;
	baseUrl?: string | null;
	rpmLimit?: number | null;
	tpmLimit?: number | null;
	rpdLimit?: number | null;
	tpdLimit?: number | null;
}

export interface ApiKeyResponse {
	id: number;
	platform: string;
	keyLabel: string | null;
	enabled: boolean;
	lastHealthCheckAt: string | null;
	lastHealthCheckStatus: string | null;
	createdAt: string;
	maskedKey: string;
	/** Limits stored on the key (null: not set on the row). */
	rpmLimit: number | null;
	tpmLimit: number | null;
	rpdLimit: number | null;
	tpdLimit: number | null;
	/** Effective limits after the key → gateway fallback, plus their
	 * source. Only populated by GET /api/keys (the list view). */
	effectiveLimits?: {
		rpm: number;
		tpm: number;
		rpd: number;
		tpd: number;
	};
	limitsSource?: "key" | "provider" | "gateway";
}

export type ApiKeyDetail = ApiKeyResponse;

export interface KeyInput extends Omit<CreateApiKeyRequest, "rawKey"> {
	userId: string;
	rawKey: string;
}

export type KeySummary = ApiKeyResponse;

export interface Model {
	id: number;
	platform: string;
	modelId: string;
	name: string;
	description: string | null;
	contextWindow: number;
	intelligenceRank: number | null;
	tier: number;
	enabled: number;
}

export type ProviderProtocol =
	| "openai_compatible"
	| "cohere_compat"
	| "google_gemini"
	| "anthropic_messages"
	| "cloudflare_openai"
	| "ai_horde"
	| "moondream";

export interface OptionalLimits {
	rpmLimit?: number | null;
	tpmLimit?: number | null;
	rpdLimit?: number | null;
	tpdLimit?: number | null;
}

export interface ProviderCatalog {
	id: string;
	name: string;
	baseUrl: string;
	authType: "bearer" | "google_api_key" | "cloudflare_account_token";
	protocol: ProviderProtocol;
	description?: string;
	keyless?: boolean;
	keyHint?: string;
	extraHeaders?: Record<string, string>;
	forceSingleToolCall?: boolean;
	modelIdentity?: "exact" | "clod" | "dreamprompting" | "simplellm";
	modelAliases?: Record<string, string>;
	electronHubProxyError?: boolean;
	ensureDone?: boolean;
	limits?: OptionalLimits;
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ChatContentPart =
	| { type: "text"; text: string }
	| {
			type: "image_url";
			image_url: { url: string; detail?: "auto" | "low" | "high" };
	  };

export type ChatContent = string | ChatContentPart[] | null;

export interface ChatMessage {
	role: ChatRole;
	content: ChatContent;
	name?: string;
	/** Reasoning the model produced before answering (Gemini thought
	 * parts, Anthropic thinking blocks), preserved by the senders so
	 * the router's empty check and clients can see it. */
	reasoning_content?: string | null;
	tool_calls?: Array<{
		id: string;
		type: "function";
		function: { name: string; arguments: string };
	}>;
	tool_call_id?: string;
}

export interface ChatTool {
	type: "function";
	function: {
		name: string;
		description?: string;
		parameters: unknown;
		required?: string[] | null;
	};
}

export interface ChatCompletionRequest {
	model: string;
	messages: ChatMessage[];
	tools?: ChatTool[];
	temperature?: number;
	max_tokens?: number;
	stream?: boolean;
	stop?: string | string[];
	tool_choice?:
		| "auto"
		| "none"
		| "required"
		| { type: "function"; function: { name: string } };
	parallel_tool_calls?: boolean;
}

export type ChatFinishReason =
	| "stop"
	| "length"
	| "tool_calls"
	| "content_filter";

export interface TokenUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
	estimated?: boolean;
}

export interface ChatCompletionResponse {
	id: string;
	object: "chat.completion";
	created: number;
	model: string;
	choices: Array<{
		index: number;
		message: ChatMessage;
		finish_reason: ChatFinishReason | null;
	}>;
	usage?: TokenUsage;
}

export interface ErrorResponse {
	error: string;
	code?: string;
}

export interface PlaygroundSession {
	id: string;
	userId: string;
	name: string;
	modelId: string;
	createdAtMs: number;
	updatedAtMs: number;
}

export interface PlaygroundMessage {
	role: ChatRole;
	content: ChatContent;
}
