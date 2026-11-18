import { resolve4, resolve6 } from "node:dns/promises";

export type PublicHostnameResolver = (hostname: string) => Promise<boolean>;

export function isPrivateEndpointHost(hostname: string): boolean {
	const host = hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");
	return (
		host.includes(":") ||
		/^[0-9.]+$/.test(host) ||
		!host.includes(".") ||
		host === "localhost" ||
		[
			".localhost",
			".local",
			".internal",
			".lan",
			".home",
			".corp",
			".test",
			".invalid",
			".example",
		].some((suffix) => host.endsWith(suffix))
	);
}

/**
 * The lexical checks POST /api/keys applies to a user-provided baseUrl,
 * shared with POST /api/providers so the two routes cannot drift apart:
 * public HTTPS, no credentials, no query or fragment, no private host.
 * No DNS lookup here, unlike validatePublicHttpsUrl: the keys route never
 * did one, and the providers route matches it.
 */
export function isValidCustomBaseUrl(candidate: string): boolean {
	try {
		const url = new URL(candidate);
		return (
			url.protocol === "https:" &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash &&
			!isPrivateEndpointHost(url.hostname)
		);
	} catch {
		return false;
	}
}

/** Dotted quad parsed as four octets, or null when malformed. Stricter
 * than Number(): an empty part ("1.2.3.") or a non-digit is rejected
 * instead of silently becoming 0. */
function parseIpv4(address: string): [number, number, number, number] | null {
	const parts = address.split(".");
	if (parts.length !== 4) return null;
	const octets: number[] = [];
	for (const part of parts) {
		if (!/^\d+$/.test(part)) return null;
		const value = Number(part);
		if (!Number.isInteger(value) || value > 255) return null;
		octets.push(value);
	}
	return octets as [number, number, number, number];
}

export function isPublicIpv4(address: string): boolean {
	const octets = parseIpv4(address);
	return octets !== null && isPublicIpv4Octets(octets);
}

function isPublicIpv4Octets(octets: [number, number, number, number]): boolean {
	const [a, b, c] = octets;
	return !(
		a === 0 ||
		a === 10 ||
		a === 127 ||
		a >= 224 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && (b === 0 || b === 168)) ||
		(a === 192 && b === 88 && c === 99) ||
		(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
		(a === 203 && b === 0 && c === 113)
	);
}

/**
 * Parse an IPv6 literal into its eight 16-bit groups. Handles `::`
 * compression (at most once, standing for at least one group) and an
 * embedded IPv4 tail (`::ffff:127.0.0.1`, `0:0:0:0:0:ffff:7f00:1`).
 * Returns null for anything malformed.
 *
 * String-prefix checks cannot do this job: expanded forms such as
 * `0:0:0:0:0:0:0:1` (loopback) or `2001:0db8:...` (documentation) dodge
 * every `startsWith` in the old check (M8). Classification below works
 * on the numbers, so compressed and expanded spellings behave alike.
 */
function expandIpv6(address: string): number[] | null {
	let value = address.toLowerCase();
	// Embedded IPv4 tail: rewrite it as two hex groups in place, so the
	// `::` next to it survives — slicing at the last colon would cut a
	// "::" in half ("64:ff9b::8.8.8.8" -> "64:ff9b:").
	const ipv4Tail = value.match(/:((?:\d{1,3}\.){3}\d{1,3})$/);
	if (ipv4Tail) {
		const ipv4 = parseIpv4(ipv4Tail[1]);
		if (!ipv4) return null;
		const hex = (n: number): string => n.toString(16);
		value =
			value.slice(0, ipv4Tail.index) +
			`:${hex((ipv4[0] << 8) | ipv4[1])}:${hex((ipv4[2] << 8) | ipv4[3])}`;
	}
	const compression = value.indexOf("::");
	if (compression !== -1 && value.indexOf("::", compression + 2) !== -1)
		return null;
	const parseGroup = (text: string): number | null =>
		/^[0-9a-f]{1,4}$/.test(text) ? Number.parseInt(text, 16) : null;
	if (compression !== -1) {
		const left = value.slice(0, compression);
		const right = value.slice(compression + 2);
		const leftTexts = left ? left.split(":") : [];
		const rightTexts = right ? right.split(":") : [];
		const parsed: number[] = [];
		for (const text of [...leftTexts, ...rightTexts]) {
			const group = parseGroup(text);
			if (group === null) return null;
			parsed.push(group);
		}
		const missing = 8 - parsed.length;
		if (missing < 1) return null;
		return [
			...parsed.slice(0, leftTexts.length),
			...Array.from({ length: missing }, () => 0),
			...parsed.slice(leftTexts.length),
		];
	}
	const texts = value.split(":");
	if (texts.length !== 8) return null;
	const groups: number[] = [];
	for (const text of texts) {
		const group = parseGroup(text);
		if (group === null) return null;
		groups.push(group);
	}
	return groups;
}

/** The IPv4 embedded in two 16-bit groups (6to4, NAT64, IPv4-mapped). */
function embeddedIpv4(
	hi: number,
	lo: number,
): [number, number, number, number] {
	return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

export function isPublicIpv6(address: string): boolean {
	const groups = expandIpv6(address);
	if (!groups) return false;
	const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
	// ::/96 and ::ffff:0:0/96: judge the embedded IPv4. Covers `::`,
	// `::1`, `::127.0.0.1` and `::ffff:127.0.0.1` in any spelling.
	if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
		if (g5 === 0) {
			if (g6 === 0) return g7 > 1 && isPublicIpv4Octets(embeddedIpv4(g6, g7));
			return isPublicIpv4Octets(embeddedIpv4(g6, g7));
		}
		if (g5 === 0xffff) return isPublicIpv4Octets(embeddedIpv4(g6, g7));
	}
	// NAT64 well-known prefix 64:ff9b::/96 is not globally routable
	// IPv6 — it only works behind a NAT64 translator. Reject outright.
	if (g0 === 0x0064 && g1 === 0xff9b) return false;
	// Outside the global unicast range 2000::/3 nothing is a public
	// address: loopback leftovers, link-local (fe80::/10), unique-local
	// (fc00::/7), multicast (ff00::/8) and every reserved range.
	if (g0 < 0x2000 || g0 > 0x3fff) return false;
	return !(
		// Documentation 2001:db8::/32.
		(g0 === 0x2001 && g1 === 0x0db8) ||
		// IETF special assignments under 2001::/23: Teredo 2001::/32,
		// benchmarking 2001:2::/48, AMT 2001:3::/32, AS112 2001:4::/32,
		// ORCHIDv1 2001:10::/28, ORCHIDv2 2001:20::/28.
		(g0 === 0x2001 &&
			(g1 === 0x0000 ||
				g1 === 0x0002 ||
				g1 === 0x0003 ||
				g1 === 0x0004 ||
				(g1 >= 0x0010 && g1 <= 0x001f) ||
				(g1 >= 0x0020 && g1 <= 0x002f))) ||
		// 6to4 2002::/16 translates to an embedded IPv4: public only
		// when that IPv4 is public.
		(g0 === 0x2002 && !isPublicIpv4Octets(embeddedIpv4(g1, g2)))
	);
}

function dnsErrorCode(error: unknown): string | null {
	if (
		!error ||
		typeof error !== "object" ||
		!("code" in error) ||
		typeof error.code !== "string"
	)
		return null;
	return error.code;
}

export async function hasPublicDnsAnswers(hostname: string): Promise<boolean> {
	const answers = await Promise.allSettled([
		resolve4(hostname),
		resolve6(hostname),
	]);
	const addresses: string[] = [];
	for (const answer of answers) {
		if (answer.status === "fulfilled") {
			addresses.push(...answer.value);
			continue;
		}
		const code = dnsErrorCode(answer.reason);
		if (code !== "ENODATA" && code !== "ENOTFOUND") return false;
	}
	return (
		addresses.length > 0 &&
		addresses.every((address) =>
			address.includes(".") ? isPublicIpv4(address) : isPublicIpv6(address),
		)
	);
}

/**
 * A user-provided custom baseUrl is a public HTTPS endpoint: lexical
 * checks on the hostname plus a DNS lookup whose every answer must be a
 * public IP (checked numerically, so expanded IPv6 spellings cannot
 * dodge the classification).
 *
 * Residual TOCTOU (M8), not closable here: the DNS answer is checked
 * immediately before the fetch — resolveBaseUrl runs on every send, so
 * there is no long-lived cached verdict — but the fetch itself resolves
 * the hostname again, so a rebinding between the check and the fetch
 * could still redirect it. Closing that gap needs fetching a pinned IP
 * with the hostname kept for TLS, and Workers fetch has no dial
 * override for that. The exposure is bounded because a custom baseUrl
 * is only reachable via platform "custom" (C1): catalog providers never
 * use a stored key baseUrl.
 */
export async function validatePublicHttpsUrl(
	candidate: string,
	resolveHost: PublicHostnameResolver = hasPublicDnsAnswers,
): Promise<URL | null> {
	try {
		const url = new URL(candidate);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			isPrivateEndpointHost(url.hostname) ||
			!(await resolveHost(url.hostname))
		)
			return null;
		return url;
	} catch {
		return null;
	}
}
