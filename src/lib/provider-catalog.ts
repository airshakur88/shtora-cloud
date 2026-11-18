import catalogJson from "./models-catalog.json";
import type { ModelsCatalog, ProviderCatalog } from "./types";

export const modelsCatalog = catalogJson as unknown as ModelsCatalog;
export const providerCatalog: ProviderCatalog[] = modelsCatalog.providers;
export const providerById: ReadonlyMap<string, ProviderCatalog> = new Map(
	providerCatalog.map((provider) => [provider.id, provider]),
);

export const KEYLESS_API_KEY = "no-key";

export function getProviderConfig(
	platform: string,
): ProviderCatalog | undefined {
	return providerById.get(platform);
}

export function normalizeProviderKey(
	platform: string,
	rawKey: unknown,
	keyless?: boolean,
): string | null {
	if (typeof rawKey === "string" && rawKey.trim().length > 0) return rawKey;
	const isKeyless = keyless ?? getProviderConfig(platform)?.keyless;
	return isKeyless ? KEYLESS_API_KEY : null;
}
