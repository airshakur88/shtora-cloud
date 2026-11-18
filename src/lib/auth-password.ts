import { deriveKey } from "@stablelib/scrypt";

const AUTH_N = 16384;
const R = 8;
const P = 1;
const AUTH_KEY_BYTES = 32;
const LEGACY_N = 32768;
const LEGACY_SALT_BYTES = 32;
const LEGACY_KEY_BYTES = 64;
const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

function fromHex(hex: string): Uint8Array | null {
	if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i += 1) {
		bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

function matches(actual: Uint8Array, expected: Uint8Array): boolean {
	if (actual.length !== expected.length) return false;
	let difference = 0;
	for (let i = 0; i < actual.length; i += 1)
		difference |= actual[i] ^ expected[i];
	return difference === 0;
}

export async function hashAuthPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const derived = deriveKey(
		encoder.encode(password),
		salt,
		AUTH_N,
		R,
		P,
		AUTH_KEY_BYTES,
	);
	return `scrypt$${AUTH_N}$${R}$${P}$${toHex(salt)}$${toHex(derived)}`;
}

export async function verifyAuthPassword(
	password: string,
	stored: string,
): Promise<boolean> {
	const parts = stored.split("$");
	if (parts.length === 6 && parts[0] === "scrypt") {
		if (
			parts[1] !== String(AUTH_N) ||
			parts[2] !== String(R) ||
			parts[3] !== String(P)
		)
			return false;
		const salt = fromHex(parts[4]);
		const expected = fromHex(parts[5]);
		if (salt?.length !== 16 || !expected || expected.length !== AUTH_KEY_BYTES)
			return false;
		return matches(
			deriveKey(encoder.encode(password), salt, AUTH_N, R, P, AUTH_KEY_BYTES),
			expected,
		);
	}

	const [saltHex, hashHex, extra] = stored.split(":");
	if (extra !== undefined || !saltHex || !hashHex) return false;
	const salt = fromHex(saltHex);
	const expected = fromHex(hashHex);
	if (
		!salt ||
		salt.length !== LEGACY_SALT_BYTES ||
		!expected ||
		expected.length !== LEGACY_KEY_BYTES
	)
		return false;
	return matches(
		deriveKey(encoder.encode(password), salt, LEGACY_N, R, P, LEGACY_KEY_BYTES),
		expected,
	);
}
