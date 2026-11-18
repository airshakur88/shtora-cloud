export type FailureKind =
	| "rate_limit"
	| "auth"
	| "payment"
	| "forbidden"
	| "server"
	| "timeout"
	| "network"
	| "bad_request";

export class ProviderError extends Error {
	readonly status: number;
	readonly kind: FailureKind;
	readonly retryAfterMs?: number;
	nativeResponse?: Response;

	constructor(
		message: string,
		status: number,
		kind: FailureKind,
		retryAfterMs?: number,
	) {
		super(message);
		this.name = "ProviderError";
		this.status = status;
		this.kind = kind;
		if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
	}
}

const MAX_RETRY_MS = 24 * 60 * 60 * 1000;

export function parseRetryAfterMs(
	headerValue: string | null,
	bodyText?: string,
): number | undefined {
	if (headerValue !== null && headerValue !== "") {
		const trimmed = headerValue.trim();
		const numeric = Number(trimmed);
		if (Number.isFinite(numeric) && numeric >= 0)
			return Math.min(Math.round(numeric * 1000), MAX_RETRY_MS);
		const date = Date.parse(trimmed);
		if (!Number.isNaN(date)) {
			const delta = date - Date.now();
			if (delta > 0) return Math.min(delta, MAX_RETRY_MS);
		}
	}
	if (bodyText) {
		const match = /try again in (\d+(?:\.\d+)?)s/.exec(bodyText);
		if (match)
			return Math.min(
				Math.round(Number.parseFloat(match[1]) * 1000),
				MAX_RETRY_MS,
			);
	}
	return undefined;
}

export function classifyStatus(status: number): FailureKind {
	if (status === 429) return "rate_limit";
	if (status === 401) return "auth";
	if (status === 402) return "payment";
	if (status === 403) return "forbidden";
	if (status === 408 || status === 504) return "timeout";
	if (status >= 500 && status < 600) return "server";
	return "bad_request";
}

async function readErrorBody(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const decoder = new TextDecoder();
	let body = "";
	let size = 0;
	try {
		while (size < 8192) {
			const { done, value } = await reader.read();
			if (done) break;
			const count = Math.min(value.byteLength, 8192 - size);
			body += decoder.decode(value.subarray(0, count), { stream: true });
			size += count;
			if (count < value.byteLength) {
				await reader.cancel();
				break;
			}
		}
		return body + decoder.decode();
	} finally {
		reader.releaseLock();
	}
}

export async function toProviderError(
	response: Response,
): Promise<ProviderError> {
	const bodyText = await readErrorBody(response).catch(() => "");
	const retryAfterMs =
		response.status === 429
			? parseRetryAfterMs(response.headers.get("retry-after"), bodyText)
			: undefined;
	return new ProviderError(
		`Upstream ${response.status}`,
		response.status,
		classifyStatus(response.status),
		retryAfterMs,
	);
}
