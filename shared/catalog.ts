import companies from "./companies.json";
import type { CatalogCompany } from "./types";

/** Curated, verified job boards (refresh with `node scripts/verify-companies.mjs`). */
export const CATALOG = companies as CatalogCompany[];
