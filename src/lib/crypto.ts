const IV_BYTES = 12;
const TAG_BYTES = 16;

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
	if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
		throw new Error("Invalid encrypted-key encoding");
	}
	const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));
	for (let i = 0; i < bytes.length; i += 1) {
		bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

async function importKey(secret: string): Promise<CryptoKey> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(secret),
	);
	return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
		"encrypt",
		"decrypt",
	]);
}

export async function encryptApiKey(
	rawKey: string,
	secret: string,
): Promise<{ ciphertext: string; iv: string; authTag: string }> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const encrypted = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv },
			await importKey(secret),
			new TextEncoder().encode(rawKey),
		),
	);
	return {
		ciphertext: toHex(encrypted.subarray(0, encrypted.length - TAG_BYTES)),
		iv: toHex(iv),
		authTag: toHex(encrypted.subarray(encrypted.length - TAG_BYTES)),
	};
}

export async function decryptApiKey(
	encrypted: { ciphertext: string; iv: string; authTag: string },
	secret: string,
): Promise<string> {
	const ciphertext = fromHex(encrypted.ciphertext);
	const tag = fromHex(encrypted.authTag);
	const combined = new Uint8Array(ciphertext.length + tag.length);
	combined.set(ciphertext);
	combined.set(tag, ciphertext.length);
	const plaintext = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: fromHex(encrypted.iv) },
		await importKey(secret),
		combined,
	);
	return new TextDecoder().decode(plaintext);
}
