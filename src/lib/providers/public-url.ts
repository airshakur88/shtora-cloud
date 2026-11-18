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

function isPublicIpv4(address: string): boolean {
	const octets = address.split(".").map(Number);
	if (
		octets.length !== 4 ||
		octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
	)
		return false;
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

function isPublicIpv6(address: string): boolean {
	const value = address.toLowerCase();
	return !(
		value.startsWith("::") ||
		value.startsWith("fc") ||
		value.startsWith("fd") ||
		/^fe[89ab]/.test(value) ||
		value.startsWith("ff") ||
		value.startsWith("2002:") ||
		value.startsWith("2001:db8:") ||
		value.startsWith("2001:0:") ||
		value.startsWith("2001:10:") ||
		value.startsWith("2001:20:") ||
		value.startsWith("2001:2:") ||
		value.startsWith("64:ff9b:")
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
