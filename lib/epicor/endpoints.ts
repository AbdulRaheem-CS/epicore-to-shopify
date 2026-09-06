/**
 * ===========================================================================
 * THE ONLY FILE YOU EDIT AFTER CAPTURING EPICOR TRAFFIC
 * ===========================================================================
 *
 * How to fill this in:
 *   1. Open portal.pilot.epicor-auto-catalog.cloud in Chrome
 *   2. DevTools -> Network -> filter "Fetch/XHR" -> tick "Preserve log"
 *   3. Click through: Category -> Group -> Part Type -> Get parts -> a part
 *      -> Buyers Guide tab
 *   4. For each request: right-click -> Copy as cURL, and save the response
 *      body to fixtures/captured/<name>.json
 *   5. Transcribe the path, method and query params below.
 *
 * Paths may contain :placeholders, which are substituted from the params
 * object passed by the client. Anything left as PLACEHOLDER will throw a
 * clear error rather than silently calling the wrong URL.
 */

export type EndpointName =
  | "token"
  | "categories"
  | "groups"
  | "partTypes"
  | "parts"
  | "partDetail"
  | "partAssets"
  | "partFitment";

export interface EndpointSpec {
  method: "GET" | "POST";
  /** Path relative to EPICOR_BASE_URL. Supports :placeholder segments. */
  path: string;
  /** Static query string params always sent with the request. */
  query?: Record<string, string>;
  /** For POST endpoints: template of the JSON body. */
  body?: Record<string, unknown>;
  /** Fixture filename used when EPICOR_MODE=fixtures. */
  fixture: string;
  /** Set false once you've confirmed the real path. */
  placeholder?: boolean;
}

export const ENDPOINTS: Record<EndpointName, EndpointSpec> = {
  // If the portal uses a session cookie or a token minted at login, capture
  // that call here. If it uses a static API key, leave this and set
  // EPICOR_TOKEN in .env instead.
  token: {
    method: "POST",
    path: "/api/auth/token",
    body: { username: ":username", password: ":password" },
    fixture: "token.json",
    placeholder: true,
  },

  categories: {
    method: "GET",
    path: "/api/catalog/categories",
    fixture: "categories.json",
    placeholder: true,
  },

  groups: {
    method: "GET",
    path: "/api/catalog/categories/:categoryId/groups",
    fixture: "groups.json",
    placeholder: true,
  },

  partTypes: {
    method: "GET",
    path: "/api/catalog/groups/:groupId/part-types",
    fixture: "part-types.json",
    placeholder: true,
  },

  // The "Get parts" button. This response is your product list.
  parts: {
    method: "GET",
    path: "/api/catalog/parts",
    query: { pageSize: "50" },
    fixture: "parts.json",
    placeholder: true,
  },

  partDetail: {
    method: "GET",
    path: "/api/catalog/parts/:partId",
    fixture: "part-detail.json",
    placeholder: true,
  },

  partAssets: {
    method: "GET",
    path: "/api/catalog/parts/:partId/assets",
    fixture: "part-assets.json",
    placeholder: true,
  },

  // The "Buyers Guide" tab. This is your vehicle fitment source.
  partFitment: {
    method: "GET",
    path: "/api/catalog/parts/:partId/applications",
    fixture: "part-fitment.json",
    placeholder: true,
  },
};

/**
 * Candidate field names, tried in order, for each value we need. Epicor
 * responses vary in casing between endpoints, and the pilot API may differ
 * from production, so we probe rather than assume. Add real field names to
 * the front of each list once you've seen a captured payload.
 */
export const FIELD_CANDIDATES = {
  partId: ["partId", "PartId", "id", "Id", "partNumberId", "sku_id"],
  partNumber: [
    "partNumber",
    "PartNumber",
    "part_number",
    "partNo",
    "PartNo",
    "sku",
    "SKU",
  ],
  brandName: [
    "manufacturer",
    "Manufacturer",
    "brandName",
    "BrandName",
    "brand",
    "mfrName",
    "lineName",
  ],
  brandId: ["brandId", "BrandId", "aaiaBrandId", "brandAAIAID", "mfrCode"],
  lineCode: ["lineCode", "LineCode", "line", "linecode"],
  title: [
    "partTypeDescription",
    "description",
    "Description",
    "productName",
    "name",
    "Name",
    "shortDescription",
  ],
  description: [
    "longDescription",
    "LongDescription",
    "marketingDescription",
    "extendedDescription",
    "description",
    "Description",
  ],
  partType: ["partType", "PartType", "partTypeName", "categoryName"],
  imageUrl: ["url", "Url", "imageUrl", "ImageUrl", "assetUrl", "uri", "href"],
  // Fitment
  baseVehicleId: ["baseVehicleId", "BaseVehicleID", "baseVehicleID", "bvid"],
  year: ["year", "Year", "yearId", "startYear"],
  make: ["make", "Make", "makeName", "MakeName"],
  model: ["model", "Model", "modelName", "ModelName"],
  submodel: ["submodel", "SubModel", "subModel", "subModelName", "trim"],
  engine: ["engine", "Engine", "engineBase", "engineDescription", "liter"],
  qualifier: ["qualifier", "Qualifier", "note", "Notes", "position"],
} as const;

/** Arrays are nested under different keys depending on the endpoint. */
export const LIST_CANDIDATES = [
  "items",
  "Items",
  "data",
  "Data",
  "results",
  "Results",
  "parts",
  "Parts",
  "records",
  "applications",
  "Applications",
  "assets",
  "Assets",
  "images",
  "value",
];
