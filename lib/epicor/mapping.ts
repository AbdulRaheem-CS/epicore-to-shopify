import { FIELD_CANDIDATES, LIST_CANDIDATES } from "./endpoints";

export interface NormalisedPart {
  epicorPartId: string | null;
  partNumber: string;
  brandName: string;
  brandId: string | null;
  lineCode: string | null;
  /** Epicor's own short title, kept separate so buildTitle can be re-run. */
  epicorTitle: string | null;
  title: string;
  description: string | null;
  partType: string | null;
  /** UPC/EAN/GTIN → Shopify's native variant barcode. */
  upc: string | null;
  /** Shipping weight → Shopify's variant weight. */
  weight: number | null;
  weightUnit: WeightUnit | null;
  /** Epicor's own tree — becomes Shopify collections. */
  category: string | null;
  group: string | null;
  attributes: Record<string, unknown>;
}

/** Shopify's WeightUnit enum. */
export type WeightUnit = "KILOGRAMS" | "GRAMS" | "POUNDS" | "OUNCES";

export interface NormalisedImage {
  sourceUrl: string;
  position: number;
  altText: string | null;
}

export interface NormalisedFitment {
  baseVehicleId: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  submodel: string | null;
  engine: string | null;
  qualifier: string | null;
  raw: Record<string, unknown>;
}

type Row = Record<string, unknown>;

/**
 * Epicor nests its arrays under different keys per endpoint, and the pilot
 * API may differ from the docs. Rather than guessing once and failing at
 * 2am, walk the known candidates, then fall back to the first array-valued
 * property anywhere in the object.
 */
export function toList(body: unknown): Row[] {
  if (Array.isArray(body)) return body as Row[];
  if (!body || typeof body !== "object") return [];

  const record = body as Row;
  for (const key of LIST_CANDIDATES) {
    const value = record[key];
    if (Array.isArray(value)) return value as Row[];
    // One level of nesting, e.g. { data: { items: [...] } }
    if (value && typeof value === "object") {
      const nested = toList(value);
      if (nested.length) return nested;
    }
  }
  for (const value of Object.values(record)) {
    if (Array.isArray(value) && value.length && typeof value[0] === "object") {
      return value as Row[];
    }
  }
  return [];
}

/** Single-object wrapper keys, e.g. { "Item": { ... } }. */
const OBJECT_CANDIDATES = [
  "item",
  "part",
  "data",
  "result",
  "value",
  "product",
  "detail",
  "record",
  "response",
];

/**
 * Detail endpoints return one object, usually wrapped. Descend through the
 * wrapper until we find something that actually looks like a part row.
 * Without this, a payload shaped { "Item": { ... } } silently maps to
 * nothing and every product arrives with a null description.
 */
export function unwrap(body: unknown, depth = 0): Row {
  if (!body || typeof body !== "object" || depth > 4) return {};
  if (Array.isArray(body)) return unwrap(body[0], depth + 1);

  const record = body as Row;
  if (looksLikePart(record)) return record;

  const lower = new Map(
    Object.entries(record).map(([k, v]) => [k.toLowerCase(), v]),
  );
  for (const key of OBJECT_CANDIDATES) {
    const value = lower.get(key);
    if (value && typeof value === "object") {
      const inner = unwrap(value, depth + 1);
      if (Object.keys(inner).length) return inner;
    }
  }

  // A wrapper of any name, as long as it is the only key.
  const keys = Object.keys(record);
  if (keys.length === 1 && record[keys[0]] && typeof record[keys[0]] === "object") {
    return unwrap(record[keys[0]], depth + 1);
  }

  return record;
}

function looksLikePart(row: Row): boolean {
  return (
    pick(row, FIELD_CANDIDATES.partNumber) !== undefined &&
    pick(row, FIELD_CANDIDATES.brandName) !== undefined
  );
}

function pick(row: Row, candidates: readonly string[]): unknown {
  for (const key of candidates) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") {
      return row[key];
    }
  }
  // Case-insensitive second pass — cheap insurance against casing surprises.
  const lower = new Map(
    Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]),
  );
  for (const key of candidates) {
    const value = lower.get(key.toLowerCase());
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function str(row: Row, candidates: readonly string[]): string | null {
  const value = pick(row, candidates);
  return value === undefined ? null : String(value).trim();
}

function num(row: Row, candidates: readonly string[]): number | null {
  const value = pick(row, candidates);
  if (value === undefined) return null;
  const parsed = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export class MappingError extends Error {
  constructor(field: string, row: Row) {
    super(
      `Could not find "${field}" in the Epicor row. Available keys: ` +
        `${Object.keys(row).join(", ") || "(none)"}. Add the real field name ` +
        `to FIELD_CANDIDATES.${field} in lib/epicor/endpoints.ts.`,
    );
    this.name = "MappingError";
  }
}

export function mapPart(row: Row): NormalisedPart {
  const partNumber = str(row, FIELD_CANDIDATES.partNumber);
  if (!partNumber) throw new MappingError("partNumber", row);

  const brandName = str(row, FIELD_CANDIDATES.brandName);
  if (!brandName) throw new MappingError("brandName", row);

  const partType = str(row, FIELD_CANDIDATES.partType);
  const epicorTitle = str(row, FIELD_CANDIDATES.title);
  const description = str(row, FIELD_CANDIDATES.description);

  // UPC and weight may be flat keys or entries in the Attributes array,
  // depending on the endpoint, so both places are checked.
  const upc = normaliseUpc(
    str(row, FIELD_CANDIDATES.upc) ?? attributeValue(row, FIELD_CANDIDATES.upc),
  );
  const rawWeight =
    str(row, FIELD_CANDIDATES.weight) ??
    attributeValue(row, FIELD_CANDIDATES.weight);
  const weight = toNumber(rawWeight);
  const weightUnit = weight === null
    ? null
    : parseWeightUnit(
        str(row, FIELD_CANDIDATES.weightUnit) ??
          attributeValue(row, FIELD_CANDIDATES.weightUnit) ??
          rawWeight,
      );

  return {
    epicorPartId: str(row, FIELD_CANDIDATES.partId),
    partNumber,
    brandName,
    brandId: str(row, FIELD_CANDIDATES.brandId),
    lineCode: str(row, FIELD_CANDIDATES.lineCode),
    epicorTitle,
    // Recomputed after the detail merge in normalize — the summary endpoint
    // often has no description, and the title formula depends on it.
    title: buildTitle({ brandName, partNumber, description, epicorTitle, partType }),
    description,
    partType,
    upc,
    weight,
    weightUnit,
    category: str(row, FIELD_CANDIDATES.category),
    group: str(row, FIELD_CANDIDATES.group),
    // Keep everything else. Cheap now, and it means new attributes appearing
    // upstream don't need a schema change.
    attributes: row,
  };
}

/**
 * Looks a value up in Epicor's Attributes array (the {Name, Value} pairs)
 * rather than among the row's own keys. Weight in particular can arrive
 * either way depending on the endpoint.
 */
function attributeValue(row: Row, candidates: readonly string[]): string | null {
  const lower = new Map(
    Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const wanted = candidates.map((c) => c.toLowerCase());

  for (const key of SPEC_LIST_KEYS) {
    const list = lower.get(key);
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      const name = str(entry as Row, SPEC_NAME_KEYS);
      if (!name) continue;
      const flat = name.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!wanted.some((w) => w.replace(/[^a-z0-9]/g, "") === flat)) continue;
      const value = str(entry as Row, SPEC_VALUE_KEYS);
      if (value) return value;
    }
  }
  return null;
}

/** Digits only. Shopify's barcode field is free text, but a UPC is not. */
function normaliseUpc(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 14 ? digits : null;
}

function toNumber(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value.replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Epicor may name the unit separately, embed it in the value ("3.4 lb"), or
 * omit it. When it is absent the caller's configured default applies, since
 * guessing between pounds and kilograms would silently mis-state shipping.
 */
export function parseWeightUnit(value: string | null): WeightUnit | null {
  if (!value) return null;
  const v = value.toLowerCase();
  if (/\b(kg|kilogram)/.test(v)) return "KILOGRAMS";
  if (/\b(lb|lbs|pound)/.test(v)) return "POUNDS";
  if (/\b(oz|ounce)/.test(v)) return "OUNCES";
  if (/\b(g|gram)\b/.test(v)) return "GRAMS";
  return null;
}

/** Shopify rejects titles over 255 characters. */
const TITLE_MAX = 255;

/**
 * Client mapping spec: Title = Manufacturer + Part Number + Part Description.
 *
 * Two readings of "Part Description". Epicor's LongDescription is a marketing
 * sentence and the client assigned that to the Shopify description, so the
 * short form is used here — part type, else PartTypeDescription — giving
 * "Northline Filtration NF-51515 Oil Filter" rather than a paragraph as the
 * product name. LongDescription is the last resort.
 *
 * The short form frequently already repeats the brand and the number, so each
 * prefix is only added when the body does not already contain it. Without
 * that you get "Northline Filtration NF-51515 Northline Filtration Oil
 * Filter NF-51515".
 */
export function buildTitle(part: {
  brandName: string;
  partNumber: string;
  description?: string | null;
  epicorTitle?: string | null;
  partType?: string | null;
}): string {
  const body = part.partType || part.epicorTitle || part.description || "";
  const prefix = [part.brandName, part.partNumber].filter(
    (bit) => bit && !contains(body, bit),
  );
  const title = [...prefix, body].filter(Boolean).join(" ").trim();
  return truncate(title || `${part.brandName} ${part.partNumber}`, TITLE_MAX);
}

function contains(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase().trim());
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export interface SpecRow {
  name: string;
  value: string;
}

/** Where Epicor hangs its extended attribute list, and how it names the pairs. */
const SPEC_LIST_KEYS = [
  "attributes",
  "specs",
  "specifications",
  "partattributes",
  "attributelist",
  "extendedattributes",
  "productattributes",
];
const SPEC_NAME_KEYS = ["name", "attributeName", "label", "key", "description"];
const SPEC_VALUE_KEYS = ["value", "attributeValue", "val", "text"];

/**
 * Flat keys that are already mapped to first-class columns, so repeating them
 * in the description would be noise.
 */
const SPEC_SKIP_KEYS = new Set(
  [
    ...Object.values(FIELD_CANDIDATES).flat(),
    "category",
    "group",
    "groupName",
    "hasImages",
    "applicationCount",
    "totalCount",
    "pageSize",
    ...SPEC_LIST_KEYS,
  ].map((k) => k.toLowerCase()),
);

const SPEC_VALUE_MAX = 200;
const SPEC_ROW_MAX = 40;

/**
 * The "available extended part details" half of the description mapping.
 *
 * Epicor delivers these as an Attributes array of {Name, Value} pairs, but
 * useful scalars (UPC, weights) also sit as flat keys on the part row, so both
 * are collected. Output is sorted and deduped: it feeds source_hash, and an
 * unstable order there would re-push every product on every run.
 */
export function specRows(attributes: unknown): SpecRow[] {
  if (!attributes || typeof attributes !== "object") return [];
  const row = attributes as Row;
  const found = new Map<string, string>();

  const lower = new Map(
    Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]),
  );

  // 1. The structured attribute list, wherever it is hung.
  for (const key of SPEC_LIST_KEYS) {
    const list = lower.get(key);
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      const name = str(entry as Row, SPEC_NAME_KEYS);
      const value = str(entry as Row, SPEC_VALUE_KEYS);
      if (name && value) found.set(name, value);
    }
  }

  // 2. Scalar leftovers on the part row itself.
  for (const [key, value] of Object.entries(row)) {
    if (SPEC_SKIP_KEYS.has(key.toLowerCase())) continue;
    if (!isDisplayableScalar(value)) continue;
    if (isInternalKey(key)) continue;
    const text = String(value).trim();
    if (!text || text.length > SPEC_VALUE_MAX) continue;
    found.set(humanise(key), text);
  }

  return [...found.entries()]
    .map(([name, value]) => ({ name, value: value.slice(0, SPEC_VALUE_MAX) }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, SPEC_ROW_MAX);
}

function isDisplayableScalar(value: unknown): boolean {
  return typeof value === "string" || typeof value === "number";
}

/** Ids, urls, counts and flags are plumbing, not product specifications. */
function isInternalKey(key: string): boolean {
  return /^_|(?:id|guid|url|uri|href|count|hash|token|code)$/i.test(key);
}

function humanise(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Shopify takes HTML here. Epicor descriptions are usually plain text, so
 * they are escaped and wrapped — but a description that already carries
 * markup is passed through rather than displayed as literal tags.
 */
export function buildDescriptionHtml(
  description: string | null,
  specs: SpecRow[],
): string {
  const parts: string[] = [];

  if (description?.trim()) {
    parts.push(
      /<[a-z][\s\S]*>/i.test(description)
        ? description
        : `<p>${escapeHtml(description.trim())}</p>`,
    );
  }

  if (specs.length) {
    const rows = specs
      .map(
        (s) =>
          `<tr><th scope="row">${escapeHtml(s.name)}</th>` +
          `<td>${escapeHtml(s.value)}</td></tr>`,
      )
      .join("");
    parts.push(
      `<h3>Specifications</h3><table><tbody>${rows}</tbody></table>`,
    );
  }

  return parts.join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function mapImages(body: unknown): NormalisedImage[] {
  const rows = toList(body);
  const seen = new Set<string>();
  const images: NormalisedImage[] = [];

  rows.forEach((row) => {
    const url =
      typeof row === "string" ? row : str(row, FIELD_CANDIDATES.imageUrl);
    if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) return;
    seen.add(url);
    images.push({
      sourceUrl: url,
      position: images.length,
      altText: typeof row === "object" ? str(row, ["altText", "caption"]) : null,
    });
  });

  return images;
}

export function mapFitment(body: unknown): NormalisedFitment[] {
  return toList(body).map((row) => ({
    baseVehicleId: str(row, FIELD_CANDIDATES.baseVehicleId),
    year: num(row, FIELD_CANDIDATES.year),
    make: str(row, FIELD_CANDIDATES.make),
    model: str(row, FIELD_CANDIDATES.model),
    submodel: str(row, FIELD_CANDIDATES.submodel),
    engine: str(row, FIELD_CANDIDATES.engine),
    qualifier: str(row, FIELD_CANDIDATES.qualifier),
    raw: row,
  }));
}

/** Human-readable single line, e.g. "2016 Honda Civic EX 2.0L". */
export function describeFitment(f: NormalisedFitment): string {
  return [f.year, f.make, f.model, f.submodel, f.engine]
    .filter(Boolean)
    .join(" ");
}

/**
 * Reports whether Epicor gave us real ACES vehicle IDs or only display text.
 * Text-only fitment means later vehicle matching is fuzzy string work, which
 * is worth knowing before the schema is signed off.
 */
export function fitmentQuality(rows: NormalisedFitment[]) {
  const withAces = rows.filter((r) => r.baseVehicleId).length;
  return {
    total: rows.length,
    withAces,
    grade: rows.length === 0 ? "none" : withAces === rows.length ? "aces" : withAces > 0 ? "partial" : "text-only",
  } as const;
}
