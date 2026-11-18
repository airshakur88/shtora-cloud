import { expect, test } from "bun:test";
import { deriveSessionTitle } from "../src/lib/playground-sessions";

test("returns short text unchanged", () => {
	expect(deriveSessionTitle("Explain recursion")).toBe("Explain recursion");
});

test("returns null for empty or whitespace-only content", () => {
	expect(deriveSessionTitle("")).toBeNull();
	expect(deriveSessionTitle("   \n  ")).toBeNull();
});

test("uses only the first non-empty line", () => {
	expect(deriveSessionTitle("First line\nSecond line")).toBe("First line");
	expect(deriveSessionTitle("\n  \nFirst real line\nSecond")).toBe(
		"First real line",
	);
});

test("collapses inner whitespace", () => {
	expect(deriveSessionTitle("  write   a   poem  ")).toBe("write a poem");
});

test("cuts long titles at a word boundary with an ellipsis", () => {
	const title = deriveSessionTitle(
		"Write a detailed explanation of how the router picks providers",
	);
	expect(title).toBe("Write a detailed explanation of how the router…");
	expect(title?.endsWith("…")).toBe(true);
	expect(title?.length).toBeLessThanOrEqual(51);
});

test("hard-cuts a single over-long word", () => {
	const word = "a".repeat(60);
	expect(deriveSessionTitle(word)).toBe(`${"a".repeat(50)}…`);
});

test("keeps a title of exactly 50 characters unchanged", () => {
	const text = "x".repeat(50);
	expect(deriveSessionTitle(text)).toBe(text);
});
