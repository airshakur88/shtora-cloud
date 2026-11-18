import { isKnownProvider, normalizeProviderKey } from "./provider-catalog";
import type { D1Database } from "./types";

/** Maximum number of keys to accept */
const _MAX_KEY_COUNT = 500;

/**
 * Represents a successfully parsed key candidate before provider validation
 */
export interface ParsedKeyCandidate {
	platform: string;
	key: string;
	label: string | null;
}

/**
 * Result of a skipped key import entry
 */
export interface SkippedKey {
	reason:
		| "unsupported_platform"
		| "empty_key"
		| "invalid_key"
		| "exceeds_limit";
}

/**
 * Result of a successful parse with validated keys
 */
export interface ParsedKeyImport {
	keys: ParsedKeyCandidate[];
	skipped: SkippedKey[];
}

/**
 * Union type for parser result: either success or error
 */
export type ParseResult =
	| { success: true; data: ParsedKeyImport }
	| { success: false; error: { message: string; code: string } };

/** Alias field names that are accepted for provider/key lookups */
const PROVIDER_FIELDS = ["platform", "provider", "name", "id"];
const KEY_FIELDS = ["key", "apiKey", "api_token", "token"];

/**
 * Reserved field names that indicate a structured format, not a flat map
 */
const FLAT_MAP_RESERVED_KEYS = [
	"version",
	"exportedAt",
	"source",
	"keys",
	"platform",
	"key",
	"label",
];

/**
 * Normalizes a label: trims, returns null if empty/whitespace
 */
function normalizeLabel(label: unknown): string | null {
	if (typeof label !== "string") return null;
	const trimmed = label.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * Extracts the value from an object using any of the given alias field names
 */
function getValueByAliases(
	obj: Record<string, unknown>,
	aliases: string[],
): unknown {
	for (const alias of aliases) {
		if (Object.hasOwn(obj, alias)) {
			return obj[alias];
		}
	}
	return undefined;
}

/**
 * Validation result for a key candidate
 */
type ValidationResult =
	| { valid: true; data: ParsedKeyCandidate }
	| {
			valid: false;
			reason: "unsupported_platform" | "empty_key" | "invalid_key";
	  };

/**
 * Validate and extract a key candidate from a key entry object
 */
async function validateAndExtractKey(
	entry: Record<string, unknown>,
	db?: D1Database,
): Promise<ValidationResult> {
	const platform = getValueByAliases(entry, PROVIDER_FIELDS);
	const rawKey = getValueByAliases(entry, KEY_FIELDS);

	// Check platform
	if (typeof platform !== "string") {
		return { valid: false, reason: "invalid_key" };
	}

	// Check raw key
	if (typeof rawKey !== "string") {
		return { valid: false, reason: "invalid_key" };
	}

	const normalizedPlatform = platform.trim().toLowerCase();

	// Check for empty platform
	if (normalizedPlatform.length === 0) {
		return { valid: false, reason: "unsupported_platform" };
	}

	// Check if platform is supported
	if (!(await isKnownProvider(normalizedPlatform, db))) {
		return { valid: false, reason: "unsupported_platform" };
	}

	// Check if key is empty
	if (rawKey.trim().length === 0) {
		return { valid: false, reason: "empty_key" };
	}

	// Check if normalizeProviderKey accepts it
	const normalized = await normalizeProviderKey(
		normalizedPlatform,
		rawKey.trim(),
		undefined,
		db,
	);
	if (normalized === null) {
		return { valid: false, reason: "invalid_key" };
	}

	const label = normalizeLabel(getValueByAliases(entry, ["label"]));

	return {
		valid: true,
		data: {
			platform: normalizedPlatform,
			key: rawKey.trim(),
			label,
		},
	};
}

/**
 * Validate a key candidate and return skip reason if invalid
 */
async function validateKeyCandidate(
	platform: string,
	rawKey: string,
	db?: D1Database,
): Promise<
	| { valid: true }
	| {
			valid: false;
			reason: "unsupported_platform" | "empty_key" | "invalid_key";
	  }
> {
	// Check if platform is supported
	if (!(await isKnownProvider(platform, db))) {
		return { valid: false, reason: "unsupported_platform" };
	}

	// Check if key is empty
	if (rawKey.trim().length === 0) {
		return { valid: false, reason: "empty_key" };
	}

	// Check if normalizeProviderKey accepts it
	const normalized = await normalizeProviderKey(
		platform,
		rawKey,
		undefined,
		db,
	);
	if (normalized === null) {
		return { valid: false, reason: "invalid_key" };
	}

	return { valid: true };
}

/**
 * Parses key import data from various supported formats.
 *
 * Supported formats:
 * 1. freellmapi format: {version, exportedAt, source, keys: [{platform, key, label?}]}
 * 2. shtora-cloud format: {version, exportedAt, source:"shtora-cloud", keys: [...]}
 * 3. flat map format: {"openai": "sk-...", "groq": "sk-..."}
 * 4. array format (CLIOpen): [{platform, key}] or [{provider/name/id, apiKey/api_token/token}]
 * 5. freellmapi keys-only: {keys: [...]} without version/source
 * 6. single-key object: {platform, key, label} (freellmapi-style)
 */
export async function parseKeyImport(
	value: unknown,
	db?: D1Database,
): Promise<ParseResult> {
	// Reject non-objects
	if (value === null || typeof value !== "object") {
		return {
			success: false,
			error: { message: "Input must be an object", code: "invalid_json" },
		};
	}

	// Reject arrays at root (only arrays inside keys: are supported)
	if (Array.isArray(value)) {
		return {
			success: false,
			error: {
				message: "Array at root not supported; use {keys: [...]}",
				code: "invalid_json",
			},
		};
	}

	const input = value as Record<string, unknown>;
	const keys: ParsedKeyCandidate[] = [];
	const skipped: SkippedKey[] = [];

	// Check if it has a "keys" property which must be an array
	if (Object.hasOwn(input, "keys")) {
		if (!Array.isArray(input.keys)) {
			return {
				success: false,
				error: { message: "Invalid keys format", code: "invalid_format" },
			};
		}

		// Check key count cap
		if (input.keys.length > _MAX_KEY_COUNT) {
			return {
				success: false,
				error: {
					message: `Too many keys: maximum ${_MAX_KEY_COUNT} allowed`,
					code: "too_many_keys",
				},
			};
		}

		// freellmapi/shtora-cloud format or keys array format
		for (const entry of input.keys) {
			const result = await validateAndExtractKey(
				entry as Record<string, unknown>,
				db,
			);
			if (result.valid) {
				keys.push(result.data);
			} else {
				skipped.push({ reason: result.reason });
			}
		}
		return { success: true, data: { keys, skipped } };
	}

	// Try flat map format first
	const flatMapResult = tryParseFlatMap(input);
	if (flatMapResult.success) {
		const result = flatMapResult.data;

		// Check key count cap
		if (result.keys.length > _MAX_KEY_COUNT) {
			return {
				success: false,
				error: {
					message: `Too many keys: maximum ${_MAX_KEY_COUNT} allowed`,
					code: "too_many_keys",
				},
			};
		}

		for (const candidate of result.keys) {
			const validation = await validateKeyCandidate(
				candidate.platform,
				candidate.key,
				db,
			);
			if (validation.valid) {
				keys.push(candidate);
			} else {
				skipped.push({ reason: validation.reason });
			}
		}
		return { success: true, data: { keys, skipped } };
	}

	// Try as single-key object (freellmapi-style single key or shtora-cloud style)
	const singleResult = await validateAndExtractKey(input, db);
	if (singleResult.valid) {
		keys.push(singleResult.data);
		return { success: true, data: { keys, skipped } };
	}

	// If validation failed for single key
	skipped.push({ reason: singleResult.reason });
	return { success: true, data: { keys, skipped } };
}

/**
 * Attempt to parse as flat map format: {"provider": "key-string"}
 */
function tryParseFlatMap(input: Record<string, unknown>): ParseResult {
	const keys: ParsedKeyCandidate[] = [];
	const entries = Object.entries(input);

	// Must have at least one entry
	if (entries.length === 0) {
		return {
			success: false,
			error: { message: "Empty object", code: "invalid_json" },
		};
	}

	// Check if this looks like a flat map: all values are non-empty strings
	// and keys don't look like reserved field names from other formats
	let isFlatMap = true;
	for (const [key, val] of entries) {
		if (typeof val !== "string" || val.trim().length === 0) {
			isFlatMap = false;
			break;
		}
		// Verify keys aren't reserved field names from other formats
		// These keys appear in structured formats (freellmapi, shtora-cloud, single-key)
		if (FLAT_MAP_RESERVED_KEYS.includes(key)) {
			isFlatMap = false;
			break;
		}
	}

	if (!isFlatMap) {
		return {
			success: false,
			error: { message: "Not a flat map format", code: "not_flat_map" },
		};
	}

	for (const [platform, rawKey] of entries) {
		if (typeof rawKey === "string" && rawKey.trim().length > 0) {
			keys.push({
				platform: platform.trim().toLowerCase(),
				key: rawKey.trim(),
				label: null,
			});
		}
	}

	return { success: true, data: { keys, skipped: [] } };
}
