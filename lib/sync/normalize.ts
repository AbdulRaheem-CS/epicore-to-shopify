import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  brand,
  fitment,
  product,
  productImage,
  rawPayload,
  syncEvent,
} from "@/db/schema";
import { stableHash, shortHash } from "@/lib/hash";
import {
  buildTitle,
  describeFitment,
  fitmentQuality,
  mapFitment,
  mapImages,
  mapPart,
  specRows,
  toList,
  unwrap,
  type NormalisedFitment,
  type NormalisedPart,
} from "@/lib/epicor/mapping";
import { env } from "@/lib/env";

export interface NormalizeCounts {
  products: number;
  images: number;
  fitmentRows: number;
  fitmentGrade: string;
  incomplete: number;
}

/**
 * Stage 2. Reads raw_payload for this run and writes the normalised tables.
 * The natural key is (brand_id, part_number) and the unique index enforces
 * it, so re-running this stage can never produce a second row.
 */
export async function normalize(syncRunId: number): Promise<NormalizeCounts> {
  const rows = await db
    .select()
    .from(rawPayload)
    .where(eq(rawPayload.syncRunId, syncRunId))
    .orderBy(rawPayload.id);

  const partsBodies = rows.filter((r) => r.endpoint === "parts");
  const detailByPart = indexByPart(rows, "partDetail");
  const assetsByPart = indexByPart(rows, "partAssets");
  const fitmentByPart = indexByPart(rows, "partFitment");

  const counts: NormalizeCounts = {
    products: 0,
    images: 0,
    fitmentRows: 0,
    fitmentGrade: "none",
    incomplete: 0,
  };

  const selected = new Set(
    [...detailByPart.keys(), ...fitmentByPart.keys()].map(String),
  );

  const summaries = partsBodies
    .flatMap((r) => toList(r.body))
    .map((row) => {
      try {
        return mapPart(row);
      } catch {
        return null;
      }
    })
    .filter((p): p is NormalisedPart => p !== null)
    .filter((p) =>
      selected.size === 0
        ? true
        : selected.has(String(p.epicorPartId ?? p.partNumber)),
    );

  const allFitmentGrades: string[] = [];

  for (const summary of summaries) {
    const partKeyId = String(summary.epicorPartId ?? summary.partNumber);

    // Detail overrides the summary where it has richer values.
    const detailBody = detailByPart.get(partKeyId);
    const merged = detailBody ? mergeDetail(summary, detailBody) : summary;
    // The title formula needs the description, which usually only arrives on
    // the detail payload — so it is built from the merged row, not the summary.
    const detail: NormalisedPart = {
      ...merged,
      title: buildTitle(merged),
    };
    const specs = specRows(detail.attributes);

    const images = mapImages(assetsByPart.get(partKeyId) ?? detailBody ?? []);
    const fits = mapFitment(fitmentByPart.get(partKeyId) ?? []);
    const quality = fitmentQuality(fits);
    allFitmentGrades.push(quality.grade);

    // Brand first — it is half the natural key.
    const brandRow = await upsertBrand(detail);

    const imageChecksums = images.map((i) => shortHash(i.sourceUrl)).sort();
    const sourceHash = stableHash({
      partNumber: detail.partNumber,
      brand: brandRow.name,
      title: detail.title,
      description: detail.description,
      partType: detail.partType,
      // Specs are rendered into descriptionHtml, so they have to gate the
      // push too — otherwise an attribute change never reaches Shopify.
      specs: specs.map((sp) => `${sp.name}=${sp.value}`),
      images: imageChecksums,
      fitment: fits.map(fitmentKeyOf).sort(),
    });

    const [saved] = await db
      .insert(product)
      .values({
        brandId: brandRow.id,
        partNumber: detail.partNumber,
        epicorProductId: detail.epicorPartId,
        category: env.PILOT_CATEGORY,
        groupName: env.PILOT_GROUP,
        partType: detail.partType,
        title: detail.title,
        description: detail.description,
        attributes: detail.attributes,
        sourceHash,
      })
      .onConflictDoUpdate({
        target: [product.brandId, product.partNumber],
        set: {
          title: detail.title,
          description: detail.description,
          partType: detail.partType,
          attributes: detail.attributes,
          epicorProductId: detail.epicorPartId,
          sourceHash,
          lastSeenAt: new Date(),
        },
      })
      .returning();

    counts.products++;

    // Images: unique on (product_id, checksum), so repeated runs are inert.
    for (const image of images) {
      await db
        .insert(productImage)
        .values({
          productId: saved.id,
          sourceUrl: image.sourceUrl,
          checksum: shortHash(image.sourceUrl),
          position: image.position,
          altText: image.altText,
        })
        .onConflictDoNothing({
          target: [productImage.productId, productImage.checksum],
        });
      counts.images++;
    }

    for (const fit of fits) {
      await db
        .insert(fitment)
        .values({
          productId: saved.id,
          baseVehicleId: fit.baseVehicleId,
          year: fit.year,
          make: fit.make,
          model: fit.model,
          submodel: fit.submodel,
          engine: fit.engine,
          qualifier: fit.qualifier,
          fitmentKey: fitmentKeyOf(fit),
          raw: fit.raw,
        })
        .onConflictDoNothing({
          target: [fitment.productId, fitment.fitmentKey],
        });
      counts.fitmentRows++;
    }

    // Scope requires title, SKU, manufacturer, description, images and
    // fitment. Anything missing is worth surfacing now, not at the demo.
    const missing: string[] = [];
    if (!detail.title) missing.push("title");
    if (!detail.description) missing.push("description");
    if (!images.length) missing.push("images");
    if (!fits.length) missing.push("fitment");
    if (missing.length) {
      counts.incomplete++;
      await db.insert(syncEvent).values({
        syncRunId,
        productId: saved.id,
        stage: "normalize",
        action: "incomplete",
        subject: `${brandRow.name} ${detail.partNumber}`,
        message: `Incomplete from Epicor: missing ${missing.join(", ")}`,
      });
    }
  }

  counts.fitmentGrade = summariseGrades(allFitmentGrades);
  return counts;
}

async function upsertBrand(part: NormalisedPart) {
  const [row] = await db
    .insert(brand)
    .values({
      name: part.brandName,
      aaiaBrandId: part.brandId,
      lineCode: part.lineCode,
    })
    .onConflictDoUpdate({
      target: brand.name,
      set: { aaiaBrandId: part.brandId, lineCode: part.lineCode },
    })
    .returning();
  return row;
}

function mergeDetail(
  summary: NormalisedPart,
  detailBody: unknown,
): NormalisedPart {
  const rows = toList(detailBody);
  const candidate = rows.length ? rows[0] : unwrap(detailBody);
  try {
    const detail = mapPart(candidate);
    return {
      ...summary,
      ...Object.fromEntries(
        Object.entries(detail).filter(([, v]) => v !== null && v !== ""),
      ),
      attributes: { ...summary.attributes, ...detail.attributes },
    } as NormalisedPart;
  } catch {
    return summary;
  }
}

function fitmentKeyOf(f: NormalisedFitment): string {
  return shortHash({
    baseVehicleId: f.baseVehicleId,
    year: f.year,
    make: f.make,
    model: f.model,
    submodel: f.submodel,
    engine: f.engine,
    qualifier: f.qualifier,
  });
}

function indexByPart(
  rows: Array<{ endpoint: string; params: unknown; body: unknown }>,
  endpoint: string,
) {
  const map = new Map<string, unknown>();
  for (const row of rows) {
    if (row.endpoint !== endpoint) continue;
    const params = (row.params ?? {}) as Record<string, string>;
    const key = String(params.partId ?? params.partNumber ?? "");
    if (key) map.set(key, row.body);
  }
  return map;
}

function summariseGrades(grades: string[]): string {
  if (!grades.length) return "none";
  if (grades.every((g) => g === "aces")) return "aces";
  if (grades.every((g) => g === "none")) return "none";
  if (grades.some((g) => g === "aces" || g === "partial")) return "partial";
  return "text-only";
}

/** Products whose content differs from what Shopify last received. */
export async function pendingProducts() {
  const rows = await db.query.product.findMany();
  return rows;
}

export { describeFitment, and, desc, eq, inArray };
