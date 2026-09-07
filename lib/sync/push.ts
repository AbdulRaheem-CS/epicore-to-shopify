import { eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  brand,
  fitment,
  product,
  productImage,
  shopifyMap,
  syncEvent,
} from "@/db/schema";
import {
  buildDescriptionHtml,
  describeFitment,
  specRows,
} from "@/lib/epicor/mapping";
import { uploadProductImage } from "@/lib/shopify/media";
import { findMissingProducts, upsertProduct } from "@/lib/shopify/products";
import { ensureCollection } from "@/lib/shopify/collections";
import { env } from "@/lib/env";

export interface PushCounts {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  imagesUploaded: number;
  /** Mapped products that had been deleted from Shopify out of band. */
  remapped: number;
  /** Distinct Shopify collections resolved or created this run. */
  collections: number;
}

/**
 * Stage 3. Only touches Shopify for products whose source_hash differs from
 * the hash we last pushed. Everything else is skipped, which is what makes
 * a second run a no-op instead of a duplicate factory.
 */
export async function push(syncRunId: number): Promise<PushCounts> {
  const counts: PushCounts = {
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    imagesUploaded: 0,
    remapped: 0,
    collections: 0,
  };

  const rows = await db
    .select({
      product,
      brandName: brand.name,
      aaiaBrandId: brand.aaiaBrandId,
      lineCode: brand.lineCode,
      map: shopifyMap,
    })
    .from(product)
    .innerJoin(brand, eq(product.brandId, brand.id))
    .leftJoin(shopifyMap, eq(shopifyMap.productId, product.id))
    .orderBy(product.partNumber);

  // The delta gate below trusts shopify_map. That trust is only valid if the
  // products it points at still exist — delete them in the Shopify admin and
  // every one is skipped as "unchanged" forever, because the hashes still
  // match. So drop any mapping whose product is gone and let the normal path
  // recreate it. One request per 100 mapped products, not one per product.
  const mapped = rows
    .filter((r) => r.map)
    .map((r) => r.map!.shopifyProductGid);

  if (mapped.length) {
    const missing = await findMissingProducts(mapped);
    for (const row of rows) {
      if (!row.map || !missing.has(row.map.shopifyProductGid)) continue;
      await db.delete(shopifyMap).where(eq(shopifyMap.productId, row.product.id));
      // Media belongs to the product, so it died with it. Leaving the stale
      // media ids behind would recreate the product with no images: the
      // upload gate below only picks up rows where shopifyMediaId is null.
      await db
        .update(productImage)
        .set({ shopifyMediaId: null, uploadedAt: null })
        .where(eq(productImage.productId, row.product.id));
      row.map = null;
      counts.remapped++;
      await logEvent(
        syncRunId,
        row.product.id,
        "remapped",
        `${row.brandName} ${row.product.partNumber}`,
        "product no longer in Shopify — will be recreated",
      );
    }
  }

  const seenCollections = new Set<string>();

  for (const row of rows) {
    const partKey = buildPartKey(row.aaiaBrandId ?? row.brandName, row.product.partNumber);
    const sku = buildSku(
      row.lineCode ?? row.aaiaBrandId ?? row.brandName,
      row.product.partNumber,
    );
    const label = `${row.brandName} ${row.product.partNumber}`;

    // The delta gate.
    if (row.map && row.map.lastPushedHash === row.product.sourceHash) {
      counts.skipped++;
      await logEvent(syncRunId, row.product.id, "skipped", label, "unchanged");
      continue;
    }

    try {
      const fits = await db
        .select()
        .from(fitment)
        .where(eq(fitment.productId, row.product.id));

      const fitmentJson = fits.map((f) => ({
        baseVehicleId: f.baseVehicleId,
        year: f.year,
        make: f.make,
        model: f.model,
        submodel: f.submodel,
        engine: f.engine,
        qualifier: f.qualifier,
      }));

      // Epicor's category and group become like-named Shopify collections.
      // Resolved per product, but ensureCollection caches per run, so five
      // products in one category cost one lookup, not five.
      const collections: string[] = [];
      if (env.SHOPIFY_COLLECTIONS) {
        for (const [level, title] of [
          ["category", row.product.category],
          ["group", row.product.groupName],
        ] as const) {
          if (!title?.trim()) continue;
          try {
            const gid = await ensureCollection(title, level);
            if (!collections.includes(gid)) collections.push(gid);
            seenCollections.add(gid);
          } catch (err) {
            // A collection failure must not lose the product itself.
            await logEvent(
              syncRunId,
              row.product.id,
              "warning",
              label,
              `collection "${title}": ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }

      const result = await upsertProduct(
        {
          partKey,
          sku,
          title: row.product.title,
          descriptionHtml: buildDescriptionHtml(
            row.product.description,
            specRows(row.product.attributes),
          ),
          vendor: row.brandName,
          productType: row.product.partType,
          barcode: row.product.upc,
          weight: row.product.weight,
          weightUnit: row.product.weightUnit,
          collections,
          fitmentJson,
          fitmentSummary: fits
            .map((f) =>
              describeFitment({
                baseVehicleId: f.baseVehicleId,
                year: f.year,
                make: f.make,
                model: f.model,
                submodel: f.submodel,
                engine: f.engine,
                qualifier: f.qualifier,
                raw: {},
              }),
            )
            .filter(Boolean)
            .join("\n"),
        },
        row.map?.shopifyProductGid ?? null,
      );

      await db
        .insert(shopifyMap)
        .values({
          productId: row.product.id,
          shopifyProductGid: result.productGid,
          shopifyVariantGid: result.variantGid,
          partKey,
          lastPushedHash: row.product.sourceHash,
          lastSyncedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: shopifyMap.productId,
          set: {
            shopifyProductGid: result.productGid,
            shopifyVariantGid: result.variantGid,
            partKey,
            lastPushedHash: row.product.sourceHash,
            lastSyncedAt: new Date(),
          },
        });

      // Images: only those with no Shopify media id yet.
      const pendingImages = await db
        .select()
        .from(productImage)
        .where(eq(productImage.productId, row.product.id))
        .orderBy(productImage.position);

      for (const image of pendingImages.filter((i) => !i.shopifyMediaId)) {
        try {
          const mediaId = await uploadProductImage(result.productGid, {
            sourceUrl: image.sourceUrl,
            altText: image.altText ?? row.product.title,
          });
          await db
            .update(productImage)
            .set({ shopifyMediaId: mediaId, uploadedAt: new Date() })
            .where(eq(productImage.id, image.id));
          counts.imagesUploaded++;
        } catch (err) {
          await logEvent(
            syncRunId,
            row.product.id,
            "failed",
            label,
            `image: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (result.action === "created") counts.created++;
      else counts.updated++;
      await logEvent(
        syncRunId,
        row.product.id,
        result.action,
        label,
        result.productGid,
      );
    } catch (err) {
      counts.failed++;
      await logEvent(
        syncRunId,
        row.product.id,
        "failed",
        label,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  counts.collections = seenCollections.size;
  return counts;
}

/**
 * Brand + part number. Uppercased and stripped of anything that is not
 * alphanumeric or a dash so trivial formatting differences upstream cannot
 * produce two keys for one physical part.
 */
/**
 * Client mapping spec: "SKU -> preferably Manufacturer/Line Code + Part
 * Number so it is globally unique." A bare part number is not unique in the
 * aftermarket — the same number exists across manufacturers — and Shopify
 * does not enforce SKU uniqueness, so the brand has to be in there.
 *
 * Distinct from part_key: part_key is the upsert identity and must never
 * change shape, this is merchant-facing text.
 */
export function buildSku(lineCodeOrBrand: string, partNumber: string) {
  const code = lineCodeOrBrand
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 20);
  const part = partNumber.toUpperCase().trim();
  if (!code) return part;
  // Some Epicor lines already prefix the part number with the line code.
  if (part.replace(/[^A-Z0-9]/g, "").startsWith(code)) return part;
  return `${code}-${part}`;
}

export function buildPartKey(brandIdOrName: string, partNumber: string) {
  const clean = (s: string) =>
    s
      .toUpperCase()
      .replace(/[^A-Z0-9-]/g, "")
      .slice(0, 60);
  return `${clean(brandIdOrName)}::${clean(partNumber)}`;
}

async function logEvent(
  syncRunId: number,
  productId: number,
  action: string,
  subject: string,
  message: string,
) {
  await db.insert(syncEvent).values({
    syncRunId,
    productId,
    stage: "push",
    action,
    subject,
    message: message.slice(0, 1000),
  });
}

export { isNull };
