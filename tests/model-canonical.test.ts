import { expect, test } from "bun:test";
import {
	canonicalModelId,
	EXCLUDED_CANONICAL_MODELS,
} from "../src/lib/model-canonical";
import { getVirtualRouter, isVirtualRouter } from "../src/lib/virtual-routers";

test("strips a leading free/ segment", () => {
	expect(canonicalModelId("free/glm-5.3-flash")).toBe("glm-5-3-flash");
	expect(canonicalModelId("free/qwen3.8-flash-next")).toBe(
		"qwen3-8-flash-next",
	);
});

test("strips a leading free- segment", () => {
	expect(canonicalModelId("free-glm-5-3-flash")).toBe("glm-5-3-flash");
});

test("bare canonical free maps to the Kilo free router", () => {
	expect(canonicalModelId("kilo-auto/free")).toBe("kilo-free");
	expect(canonicalModelId("openrouter/free")).toBe("kilo-free");
	expect(canonicalModelId("free")).toBe("kilo-free");
});

test("keeps a trailing -free variant suffix", () => {
	expect(canonicalModelId("qwen/qwen3.8-27b-free")).toBe("qwen3-8-27b-free");
});

test("still strips the :free suffix", () => {
	expect(canonicalModelId("nvidia/nemotron-3-ultra-550b-a55b:free")).toBe(
		"nemotron-3-ultra-550b-a55b",
	);
});

test("auto is excluded from ordinary model listings", () => {
	expect(EXCLUDED_CANONICAL_MODELS.has("auto")).toBe(true);
	expect(EXCLUDED_CANONICAL_MODELS.has("kilo-free")).toBe(false);
});

test("virtual router membership", () => {
	expect(isVirtualRouter("coding")).toBe(true);
	expect(isVirtualRouter("auto")).toBe(true);
	expect(isVirtualRouter("fast")).toBe(true);
	expect(isVirtualRouter("smart")).toBe(true);
	expect(isVirtualRouter("vision")).toBe(true);
	expect(isVirtualRouter("gpt-oss-120b")).toBe(false);
	const coding = getVirtualRouter("coding");
	expect(coding?.members).toContain("qwen3-coder-plus");
	expect(coding?.members).not.toContain("auto");
	expect(getVirtualRouter("shtora/coding")?.id).toBe("coding");
});
