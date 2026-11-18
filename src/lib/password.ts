/**
 * Password hashing utilities using @stablelib/scrypt
 * RFC 7914 compliant implementation
 */

import { deriveKey } from "@stablelib/scrypt";

// RFC 7914 recommended parameters: N=2^15, r=8, p=1
const N = 32768; // CPU/memory cost parameter (2^15, power of 2)
const r = 8; // Block size parameter
const p = 1; // Parallelization parameter

// Salt length: 32 bytes (256 bits) - recommended for scrypt
const SALT_LENGTH = 32;

// Key length: 64 bytes (512 bits)
const KEY_LENGTH = 64;

/**
 * Generate a cryptographically secure random salt
 * @returns Uint8Array of random bytes
 */
export function generateSalt(length: number = SALT_LENGTH): Uint8Array {
	const salt = new Uint8Array(length);
	if (typeof crypto !== "undefined" && crypto.getRandomValues) {
		crypto.getRandomValues(salt);
	} else {
		// Fallback for non-browser environments (shouldn't happen in vinext)
		for (let i = 0; i < length; i++) {
			salt[i] = Math.floor(Math.random() * 256);
		}
	}
	return salt;
}

/**
 * Convert string to Uint8Array using UTF-8
 */
function toBytes(str: string): Uint8Array {
	return new TextEncoder().encode(str);
}

/**
 * Convert Uint8Array to hex string
 */
function toHex(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Hash a password using scrypt
 * Returns hex-encoded salt:hash
 */
export async function hashPassword(password: string): Promise<string> {
	const salt = generateSalt();
	return hashPasswordWithSalt(password, salt);
}

/**
 * Hash a password with a given salt
 */
export async function hashPasswordWithSalt(
	password: string,
	salt: Uint8Array,
): Promise<string> {
	const hashBytes = deriveKey(toBytes(password), salt, N, r, p, KEY_LENGTH);
	return `${toHex(salt)}:${toHex(hashBytes)}`;
}

/**
 * Verify a password against a stored hash
 * Hash should be in format "salt:hash" (both hex encoded)
 */
export async function verifyPassword(
	password: string,
	hash: string,
): Promise<boolean> {
	try {
		const [saltHex, expectedHash] = hash.split(":");
		if (!saltHex || !expectedHash) {
			return false;
		}

		const salt = hexToUint8Array(saltHex);
		const computedHash = deriveKey(
			toBytes(password),
			salt,
			N,
			r,
			p,
			KEY_LENGTH,
		);

		return toHex(computedHash) === expectedHash;
	} catch {
		return false;
	}
}

/**
 * Hash an API key using scrypt
 */
export async function hashApiKey(apiKey: string): Promise<string> {
	const salt = generateSalt();
	return hashApiKeyWithSalt(apiKey, salt);
}

/**
 * Hash an API key with a specific salt
 */
export async function hashApiKeyWithSalt(
	apiKey: string,
	salt: Uint8Array,
): Promise<string> {
	const hashBytes = deriveKey(toBytes(apiKey), salt, N, r, p, KEY_LENGTH);
	return `${toHex(salt)}:${toHex(hashBytes)}`;
}

/**
 * Verify an API key against a stored hash
 */
export async function verifyApiKey(
	apiKey: string,
	hash: string,
): Promise<boolean> {
	try {
		const [saltHex, expectedHash] = hash.split(":");
		if (!saltHex || !expectedHash) {
			return false;
		}

		if (
			!isValidHex(saltHex, SALT_LENGTH * 2) ||
			!isValidHex(expectedHash, KEY_LENGTH * 2)
		) {
			return false;
		}

		const salt = hexToUint8Array(saltHex);
		const computedHash = deriveKey(toBytes(apiKey), salt, N, r, p, KEY_LENGTH);

		return toHex(computedHash) === expectedHash;
	} catch {
		return false;
	}
}

/**
 * Check if scrypt parameters are valid
 */
export function isValidScryptParams(
	iterations: number,
	rParam: number,
	pParam: number,
): boolean {
	if (!Number.isInteger(iterations) || iterations <= 1) {
		return false;
	}
	if (!Number.isInteger(rParam) || rParam <= 0) {
		return false;
	}
	if (!Number.isInteger(pParam) || pParam <= 0) {
		return false;
	}

	// Validate N is a power of 2
	if (!Number.isInteger(Math.log2(iterations))) {
		return false;
	}

	// Validate the memory cost constraint: N * r <= 2^30
	if (iterations * rParam > 1073741824) {
		return false;
	}

	// Validate CPU and memory limits
	if (iterations * rParam * pParam > 2147483648) {
		return false;
	}

	return true;
}

/**
 * Convert a hex string to Uint8Array
 */
function hexToUint8Array(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
	}
	return bytes;
}

/**
 * Check if string is valid hex with expected length
 */
function isValidHex(str: string, expectedLength: number): boolean {
	if (str.length !== expectedLength) {
		return false;
	}
	return /^[0-9a-fA-F]+$/.test(str);
}

/**
 * Generate a secure API key (random string)
 */
export function generateApiKey(length: number = 32): string {
	const bytes = new Uint8Array(length);
	if (typeof crypto !== "undefined" && crypto.getRandomValues) {
		crypto.getRandomValues(bytes);
	} else {
		for (let i = 0; i < length; i++) {
			bytes[i] = Math.floor(Math.random() * 256);
		}
	}
	return toHex(bytes);
}
