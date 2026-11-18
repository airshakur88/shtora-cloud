import type { NextConfig } from "next";

/**
 * Security headers (M5). Single source, applied by vinext 1.4.5 from
 * `headers()` to pages, route handlers and static assets — no middleware.ts
 * is needed, and this vinext version treats middleware.ts as deprecated in
 * favour of proxy.ts (both files together are a build error), so the
 * headers live here instead of in a middleware file.
 *
 * CSP notes: script/style 'unsafe-inline' stays because Next.js RSC
 * streaming and Tailwind rely on inline scripts and styles; there is no
 * external script, font or image origin in the app (next/font self-hosts
 * Inter), so every other directive is 'self' or stricter.
 */
const securityHeaders = [
	{
		key: "Content-Security-Policy",
		value: [
			"default-src 'self'",
			"script-src 'self' 'unsafe-inline'",
			"style-src 'self' 'unsafe-inline'",
			"img-src 'self' data: blob:",
			"font-src 'self'",
			"connect-src 'self'",
			"frame-ancestors 'none'",
			"form-action 'self'",
			"base-uri 'self'",
			"object-src 'none'",
			"upgrade-insecure-requests",
		].join("; "),
	},
	{ key: "X-Frame-Options", value: "DENY" },
	{
		key: "Strict-Transport-Security",
		value: "max-age=63072000; includeSubDomains; preload",
	},
	{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
	{
		key: "Permissions-Policy",
		value:
			"camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
	},
	{ key: "X-Content-Type-Options", value: "nosniff" },
];

const nextConfig: NextConfig = {
	async headers() {
		return [{ source: "/:path*", headers: securityHeaders }];
	},
};

export default nextConfig;
