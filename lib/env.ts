import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const env = {
  DATABASE_URL: required("DATABASE_URL"),

  SHOPIFY_STORE: optional("SHOPIFY_STORE"),
  SHOPIFY_TOKEN: optional("SHOPIFY_TOKEN"),
  SHOPIFY_API_VERSION: optional("SHOPIFY_API_VERSION", "2026-07"),
  SHOPIFY_PRODUCT_STATUS: optional("SHOPIFY_PRODUCT_STATUS", "DRAFT"),
  SHOPIFY_PILOT_TAG: optional("SHOPIFY_PILOT_TAG", "epicor-pilot"),

  EPICOR_MODE: optional("EPICOR_MODE", "fixtures") as "fixtures" | "live",
  EPICOR_BASE_URL: optional("EPICOR_BASE_URL"),
  EPICOR_AUTH_STYLE: optional("EPICOR_AUTH_STYLE", "bearer"),
  EPICOR_TOKEN: optional("EPICOR_TOKEN"),
  EPICOR_USERNAME: optional("EPICOR_USERNAME"),
  EPICOR_PASSWORD: optional("EPICOR_PASSWORD"),

  PILOT_CATEGORY: optional("PILOT_CATEGORY", "Ignition & Engine Filters"),
  PILOT_GROUP: optional("PILOT_GROUP", "Engine Filters & PCV"),
  PILOT_PART_TYPE: optional("PILOT_PART_TYPE", "Oil Filter"),
  PILOT_BRAND: optional("PILOT_BRAND"),
  PILOT_PART_LIMIT: Number(optional("PILOT_PART_LIMIT", "5")),
};

/** Metafields the pilot writes. part_key MUST have unique values enabled. */
export const METAFIELDS = {
  partKey: { namespace: "epicor", key: "part_key" },
  fitment: { namespace: "fitment", key: "applications" },
  fitmentText: { namespace: "fitment", key: "summary" },
} as const;
