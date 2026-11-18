import { expect, test } from "bun:test";
import { isPublicIpv4, isPublicIpv6 } from "../src/lib/providers/public-url";

// SSRF guard (M8): the public-IP classification must judge the address
// numerically, not by string prefix. Expanded spellings of a private
// address must be rejected exactly like the compressed spelling — the
// old startsWith checks let `0:0:0:0:0:0:0:1` (loopback) and
// `2001:0db8:...` (documentation) through.

const IPV6_CASES: Array<[address: string, isPublic: boolean]> = [
	// Genuinely public.
	["2606:4700:4700::1111", true],
	["2001:4860:4860::8888", true],
	["2a00:1450:4001:800::200e", true],
	["2001:4860:4860:0000:0000:0000:0000:8888", true],
	// Loopback and unspecified, compressed and expanded.
	["::1", false],
	["0:0:0:0:0:0:0:1", false],
	["0000:0000:0000:0000:0000:0000:0000:0001", false],
	["::", false],
	["0:0:0:0:0:0:0:0", false],
	// Link-local and unique-local, compressed and expanded.
	["fe80::1", false],
	["fe80:0000:0000:0000:0000:0000:0000:0001", false],
	["febf::1", false],
	["fc00::1", false],
	["fc00:0000:0000:0000:0000:0000:0000:0001", false],
	["fd12:3456::1", false],
	// Multicast.
	["ff02::1", false],
	["ff00:0000:0000:0000:0000:0000:0000:0001", false],
	// Documentation, compressed and expanded.
	["2001:db8::1", false],
	["2001:0db8:0000:0000:0000:0000:0000:0001", false],
	// Teredo, ORCHID, benchmarking, AMT, AS112.
	["2001::1", false],
	["2001:0000:0000:0000:0000:0000:0000:0001", false],
	["2001:10::1", false],
	["2001:1f::1", false],
	["2001:20::1", false],
	["2001:2f::1", false],
	["2001:2::1", false],
	["2001:3::1", false],
	["2001:4::1", false],
	// NAT64 well-known prefix: not globally routable IPv6.
	["64:ff9b::8.8.8.8", false],
	["0064:ff9b:0000:0000:0000:0000:0808:0808", false],
	// IPv4-mapped and IPv4-compatible: the embedded IPv4 decides.
	["::ffff:8.8.8.8", true],
	["::ffff:0808:0808", true],
	["0:0:0:0:0:ffff:808:808", true],
	["::ffff:127.0.0.1", false],
	["::ffff:10.0.0.1", false],
	["::ffff:0a00:0001", false],
	["::8.8.8.8", true],
	["::127.0.0.1", false],
	// 6to4: the embedded IPv4 decides.
	["2002:0808:0808::1", true],
	["2002:0a00:0001::1", false],
	["2002:7f00:0001::1", false],
	// Outside global unicast entirely.
	["::1:2:3:4", false],
	["4000::1", false],
	["100::1", false],
	// Malformed input fails closed.
	["not-an-address", false],
	["1:2:3:4:5:6:7:8:9", false],
	["1::2::3", false],
	["gggg::1", false],
	["::ffff:999.0.0.1", false],
];

test("isPublicIpv6 rejects private and special addresses in any spelling", () => {
	for (const [address, isPublic] of IPV6_CASES) {
		expect(isPublicIpv6(address), address).toBe(isPublic);
	}
});

const IPV4_CASES: Array<[address: string, isPublic: boolean]> = [
	["8.8.8.8", true],
	["1.1.1.1", true],
	["127.0.0.1", false],
	["10.0.0.1", false],
	["172.16.0.1", false],
	["172.31.255.255", false],
	["172.32.0.1", true],
	["192.168.1.1", false],
	["169.254.1.1", false],
	["100.64.0.1", false],
	["192.0.2.1", false],
	["198.51.100.1", false],
	["203.0.113.1", false],
	["224.0.0.1", false],
	["0.0.0.0", false],
	// Malformed input fails closed (an empty part used to parse as 0).
	["1.2.3.", false],
	["1.2.3", false],
	["1.2.3.4.5", false],
	["256.0.0.1", false],
	["1.2.3.x", false],
	["", false],
];

test("isPublicIpv4 rejects private and malformed addresses", () => {
	for (const [address, isPublic] of IPV4_CASES) {
		expect(isPublicIpv4(address), address).toBe(isPublic);
	}
});
