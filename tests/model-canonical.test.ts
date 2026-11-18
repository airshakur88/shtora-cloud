import { expect, test } from "bun:test";
import {
	canonicalModelId,
	comboboxModelLabel,
	displayModelName,
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

test("display name strips the trailing provider in parentheses", () => {
	expect(displayModelName("Cydonia 24B v4.3 (AI Horde)", "aihorde")).toBe(
		"Cydonia 24B v4.3",
	);
	expect(displayModelName("Llama 4 Scout (CF)", "cloudflare")).toBe(
		"Llama 4 Scout",
	);
	expect(displayModelName("Nemotron 3 Ultra 550B (NV)", "nvidia")).toBe(
		"Nemotron 3 Ultra 550B",
	);
	expect(
		displayModelName("Qwen3Guard Gen 8B (OVH)", "ovh", "OVH AI Endpoints"),
	).toBe("Qwen3Guard Gen 8B");
	expect(
		displayModelName("Gemma SEA-LION v4 27B (SEA-LION)", "sealion", "SEA-LION"),
	).toBe("Gemma SEA-LION v4 27B");
	expect(displayModelName("GLM 4.7 Flash (ElectronHub)", "electronhub")).toBe(
		"GLM 4.7 Flash",
	);
});

test("display name strips upstream free markers", () => {
	expect(displayModelName("Gemma 4 31B (free)", "openrouter")).toBe(
		"Gemma 4 31B",
	);
	expect(
		displayModelName("Nemotron 3 Ultra 550B (free, slow)", "openrouter"),
	).toBe("Nemotron 3 Ultra 550B");
	expect(displayModelName("BazaarLink Auto (free router)", "bazaarlink")).toBe(
		"BazaarLink Auto",
	);
	expect(displayModelName("Muse Glimmer 30B (Routeway free)", "routeway")).toBe(
		"Muse Glimmer 30B",
	);
});

test("display name keeps parentheticals that carry model info", () => {
	expect(displayModelName("GLM 4.7 (FP4)", "inferbase")).toBe("GLM 4.7 (FP4)");
	expect(displayModelName("Qwen3Guard Gen 8B (OVH safety)", "ovh")).toBe(
		"Qwen3Guard Gen 8B (OVH safety)",
	);
	expect(displayModelName("Command R (08-2024)", "cohere")).toBe(
		"Command R (08-2024)",
	);
	expect(displayModelName("North Mini Code", "cohere")).toBe("North Mini Code");
});

test("combobox label strips a trailing version date", () => {
	expect(comboboxModelLabel("Command R (08-2024)")).toBe("Command R");
	expect(comboboxModelLabel("Command R7B (12-2024)")).toBe("Command R7B");
	expect(comboboxModelLabel("Command-A (03-2025)")).toBe("Command-A");
	expect(comboboxModelLabel("Cydonia 24B v4.3")).toBe("Cydonia 24B v4.3");
	expect(comboboxModelLabel("GLM 4.7 (FP4)")).toBe("GLM 4.7 (FP4)");
	expect(comboboxModelLabel("Qwen3Guard Gen 8B (OVH safety)")).toBe(
		"Qwen3Guard Gen 8B (OVH safety)",
	);
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
