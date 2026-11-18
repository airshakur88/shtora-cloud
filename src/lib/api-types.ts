/**
 * API response types for shtora-cloud
 * Common response shapes for API endpoints
 */

// Pagination types
export interface PaginatedResponse<T> {
	data: T[];
	total: number;
	page: number;
	limit: number;
}

export interface PaginationParams {
	page?: number;
	limit?: number;
}

export interface PaginationResult {
	total: number;
	page: number;
	limit: number;
}

// Standard API response
export interface ApiResponse<T> {
	success: boolean;
	data: T;
	message?: string;
}

// Error response
export interface ApiErrorResponse {
	success: false;
	message: string;
	errors?: Record<string, string[]>;
}

// User response types
export interface UserProfile {
	id: string;
	email: string;
	name: string;
	role: string;
	createdAt: Date;
}

export interface UserSession {
	id: string;
	userId: string;
	createdAt: Date;
	expiresAt: Date;
}

// API Key response types
export interface ApiKeyListItem {
	id: string;
	userId: string;
	name: string;
	scopes: string[];
	createdAt: Date;
	lastUsedAt?: Date;
	expiresAt?: Date;
}

export interface ApiKeyDetailResponse extends ApiKeyListItem {
	key?: string;
}

// Model response types
export interface ModelListItem {
	id: string;
	name: string;
	provider: string;
	contextLength: number;
	rateLimit: number;
	enabled: boolean;
}

export interface ModelDetailResponse extends ModelListItem {
	baseUrl?: string;
	apiKey?: string;
}

// Health check response
export interface HealthCheckResponse {
	status: "ok" | "error";
	timestamp: Date;
	version: string;
}

export interface CheckResult {
	name: string;
	status: "ok" | "error" | "warning";
	message?: string;
}

// Authentication responses
export interface LoginResponse {
	user: UserProfile;
	token: string;
	session: UserSession;
}

export interface RegisterResponse {
	user: UserProfile;
	token: string;
}

export interface TokenRefreshResponse {
	token: string;
	expiresAt: Date;
}

// Rate limit response
export interface RateLimitResponse {
	limit: number;
	remaining: number;
	reset: Date;
}

// Model usage response
export interface ModelUsageResponse {
	modelId: string;
	usage: number;
	limit: number;
	reset: Date;
}

// Statistics response
export interface SystemStatsResponse {
	users: number;
	models: number;
	apiKeys: number;
	requests: number;
	errors: number;
}

// Common success message
export interface SuccessMessage {
	message: string;
}

// Bulk operation response
export interface BulkOperationResponse {
	success: number;
	failed: number;
	errors?: Array<{ id: string; message: string }>;
}

// List responses with filtering
export interface ListResponse<T> {
	items: T[];
	total: number;
	hasNext: boolean;
	hasPrev: boolean;
}

// Search response
export interface SearchResponse<T> {
	results: T[];
	total: number;
	query: string;
}

// API Key types (re-exported from types.ts for convenience)
export type {
	ApiKey,
	ApiKeyRecord,
	ApiKeyResponse,
	CreateApiKeyRequest,
} from "@/lib/types";
