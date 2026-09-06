import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { brand, fitment, product, productImage, shopifyMap } from "@/db/schema";

export const dynamic = "force-dynamic";

/** Everything the pilot proved, in one payload — handy for the demo. */
export async function GET() {
  const products = await db
    .select({ product, brandName: brand.name, map: shopifyMap })
    .from(product)
    .innerJoin(brand, eq(product.brandId, brand.id))
    .leftJoin(shopifyMap, eq(shopifyMap.productId, product.id))
    .orderBy(product.partNumber);

  const payload = [];
  for (const row of products) {
    const [images, fits] = await Promise.all([
      db.select().from(productImage).where(eq(productImage.productId, row.product.id)),
      db.select().from(fitment).where(eq(fitment.productId, row.product.id)),
    ]);
    payload.push({
      partNumber: row.product.partNumber,
      manufacturer: row.brandName,
      title: row.product.title,
      description: row.product.description,
      partType: row.product.partType,
      sourceHash: row.product.sourceHash,
      shopify: row.map
        ? {
            productGid: row.map.shopifyProductGid,
            variantGid: row.map.shopifyVariantGid,
            partKey: row.map.partKey,
            inSyncWithSource: row.map.lastPushedHash === row.product.sourceHash,
            lastSyncedAt: row.map.lastSyncedAt,
          }
        : null,
      images: images.map((i) => ({
        sourceUrl: i.sourceUrl,
        shopifyMediaId: i.shopifyMediaId,
      })),
      fitment: fits.map((f) => ({
        baseVehicleId: f.baseVehicleId,
        year: f.year,
        make: f.make,
        model: f.model,
        submodel: f.submodel,
        engine: f.engine,
      })),
    });
  }

  return NextResponse.json({ count: payload.length, products: payload });
}
