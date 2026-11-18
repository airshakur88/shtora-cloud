import { isRecord } from "./token-estimates";

// The wire shape of GET /api/dashboard/catalog, shared by the models and
// providers pages. Both pages used to define their own `isCatalogResponse`
// under the same name while validating different slices of the same
// payload (M26) — the models page checked id/name only, the providers
// page checked the provider stats and ignored the models entirely. One
// guard validates the full response, so a malformed payload fails the
// same way on both pages.

export interface CatalogProvider {
	id: string;
	name: string;
	modelCount: number;
	globalKeys: number;
	personalKeys: number;
}

export interface CatalogModel {
	id: string;
	name: string;
	platform: string;
	enabled: boolean;
	supportsTools: boolean;
	supportsVision: boolean;
	contextWindow: number | null;
	globalKeyCount: number;
	personalKeyCount: number;
	/** Router description, present only on virtual-router rows. */
	description?: string;
	/** Display names of the router members, present only on virtual-router rows. */
	memberNames?: string[];
}

export interface CatalogResponse {
	providers: CatalogProvider[];
	models: CatalogModel[];
}

export function isCatalogProvider(value: unknown): value is CatalogProvider {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.name === "string" &&
		typeof value.modelCount === "number" &&
		typeof value.globalKeys === "number" &&
		typeof value.personalKeys === "number"
	);
}

export function isCatalogModel(value: unknown): value is CatalogModel {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.name === "string" &&
		typeof value.platform === "string" &&
		typeof value.enabled === "boolean" &&
		typeof value.supportsTools === "boolean" &&
		typeof value.supportsVision === "boolean" &&
		(typeof value.contextWindow === "number" || value.contextWindow === null) &&
		typeof value.globalKeyCount === "number" &&
		typeof value.personalKeyCount === "number" &&
		(value.description === undefined ||
			typeof value.description === "string") &&
		(value.memberNames === undefined ||
			(Array.isArray(value.memberNames) &&
				value.memberNames.every((name) => typeof name === "string")))
	);
}

export function isCatalogResponse(value: unknown): value is CatalogResponse {
	if (!isRecord(value)) return false;
	return (
		Array.isArray(value.providers) &&
		Array.isArray(value.models) &&
		value.providers.every(isCatalogProvider) &&
		value.models.every(isCatalogModel)
	);
}
