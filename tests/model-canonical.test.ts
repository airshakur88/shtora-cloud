import { expect, test } from "bun:test";
import {
	canonicalModelId,
	comboboxModelLabel,
	displayModelName,
	EXCLUDED_CANONICAL_MODELS,
	formatContextWindow,
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

test("formats context windows as whole K/M units", () => {
	expect(formatContextWindow(0)).toBe("—");
	expect(formatContextWindow(null)).toBe("—");
	expect(formatContextWindow(undefined)).toBe("—");
	expect(formatContextWindow(1000)).toBe("1K");
	expect(formatContextWindow(4000)).toBe("4K");
	expect(formatContextWindow(4096)).toBe("4K");
	expect(formatContextWindow(8000)).toBe("8K");
	expect(formatContextWindow(8192)).toBe("8K");
	expect(formatContextWindow(16000)).toBe("16K");
	expect(formatContextWindow(16384)).toBe("16K");
	expect(formatContextWindow(24000)).toBe("24K");
	expect(formatContextWindow(32000)).toBe("32K");
	expect(formatContextWindow(32768)).toBe("32K");
	expect(formatContextWindow(33000)).toBe("33K");
	expect(formatContextWindow(40000)).toBe("40K");
	expect(formatContextWindow(62000)).toBe("62K");
	expect(formatContextWindow(128000)).toBe("128K");
	expect(formatContextWindow(131000)).toBe("131K");
	expect(formatContextWindow(131042)).toBe("131K");
	expect(formatContextWindow(131072)).toBe("131K");
	expect(formatContextWindow(200000)).toBe("200K");
	expect(formatContextWindow(256000)).toBe("256K");
	expect(formatContextWindow(262000)).toBe("262K");
	expect(formatContextWindow(262144)).toBe("262K");
	expect(formatContextWindow(400000)).toBe("400K");
	expect(formatContextWindow(524000)).toBe("524K");
	expect(formatContextWindow(1000000)).toBe("1M");
	expect(formatContextWindow(1048576)).toBe("1M");
	expect(formatContextWindow(1050000)).toBe("1M");
});

test("virtual router membership", () => {
	expect(isVirtualRouter("coding")).toBe(true);
	expect(isVirtualRouter("auto")).toBe(true);
	expect(isVirtualRouter("fast")).toBe(true);
	expect(isVirtualRouter("smart")).toBe(true);
	expect(isVirtualRouter("vision")).toBe(true);
	expect(isVirtualRouter("3d")).toBe(true);
	expect(isVirtualRouter("gpt-oss-120b")).toBe(false);
	const coding = getVirtualRouter("coding");
	expect(coding?.members).toContain("qwen3-coder-plus");
	expect(coding?.members).not.toContain("auto");
	expect(getVirtualRouter("shtora/coding")?.id).toBe("coding");
	const router3d = getVirtualRouter("shtora/3d");
	expect(router3d?.id).toBe("3d");
	expect(router3d?.name).toBe("Shtora 3D");
	expect(router3d?.members).toContain("qwen3-coder-plus");
	expect(router3d?.members).toContain("gpt-5-4-mini");
});
