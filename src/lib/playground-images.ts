import { getImagesBucket } from "./env";
import type { ChatContent, ChatContentPart, ChatMessage } from "./types";

export const IMAGE_URL_PREFIX = "/api/playground/images/";

/** Key pattern accepted by the upload and serve routes. */
const IMAGE_KEY_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpeg|webp|gif)$/i;

export function imageKeyFromUrl(url: string): string | null {
	if (!url.startsWith(IMAGE_URL_PREFIX)) return null;
	const key = url.slice(IMAGE_URL_PREFIX.length);
	return IMAGE_KEY_PATTERN.test(key) ? key : null;
}

/**
 * Vision-capable providers only accept inline `data:` URLs. Playground images
 * live in R2, so the stored object is read back and inlined before routing.
 */
async function toDataUrl(key: string): Promise<string | null> {
	const object = await getImagesBucket().get(key);
	if (!object) return null;
	const bytes = new Uint8Array(await object.arrayBuffer());
	let binary = "";
	const chunkSize = 0x8000;
	for (let index = 0; index < bytes.length; index += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
	}
	const mime = object.httpMetadata?.contentType ?? "application/octet-stream";
	return `data:${mime};base64,${btoa(binary)}`;
}

export class PlaygroundImageError extends Error {
	constructor(key: string) {
		super(`Playground image not found: ${key}`);
		this.name = "PlaygroundImageError";
	}
}

async function resolveContent(content: ChatContent): Promise<ChatContent> {
	if (!Array.isArray(content)) return content;
	const parts: ChatContentPart[] = [];
	for (const part of content) {
		if (part.type !== "image_url") {
			parts.push(part);
			continue;
		}
		const key = imageKeyFromUrl(part.image_url.url);
		if (!key) {
			parts.push(part);
			continue;
		}
		const dataUrl = await toDataUrl(key);
		if (!dataUrl) throw new PlaygroundImageError(key);
		parts.push({
			type: "image_url",
			image_url: {
				url: dataUrl,
				...(part.image_url.detail ? { detail: part.image_url.detail } : {}),
			},
		});
	}
	return parts;
}

/** Replaces playground R2 image references with inline base64 data URLs. */
export async function resolvePlaygroundImages(
	messages: ChatMessage[],
): Promise<ChatMessage[]> {
	const resolved: ChatMessage[] = [];
	for (const message of messages) {
		resolved.push({
			...message,
			content: await resolveContent(message.content),
		});
	}
	return resolved;
}
