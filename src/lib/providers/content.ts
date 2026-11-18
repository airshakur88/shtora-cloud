import type { ChatContent, ChatContentPart } from "../types";

export interface InlineImage {
	mimeType: string;
	data: string;
}

export function textFromContent(content: ChatContent): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is Extract<ChatContentPart, { type: "text" }> =>
				part.type === "text",
		)
		.map((part) => part.text)
		.join("");
}

export function imageParts(
	content: ChatContent,
): Extract<ChatContentPart, { type: "image_url" }>[] {
	if (!Array.isArray(content)) return [];
	return content.filter(
		(part): part is Extract<ChatContentPart, { type: "image_url" }> =>
			part.type === "image_url",
	);
}

export function parseInlineImage(url: string): InlineImage | null {
	const match =
		/^data:(image\/(?:png|jpeg|webp|gif|heic|heif));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(
			url,
		);
	if (!match || match[2].length % 4 !== 0) return null;
	return { mimeType: match[1].toLowerCase(), data: match[2] };
}

export function hasImageContent(content: ChatContent): boolean {
	return imageParts(content).length > 0;
}
