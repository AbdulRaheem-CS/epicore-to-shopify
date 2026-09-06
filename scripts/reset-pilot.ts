import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "@/db";
import { env } from "@/lib/env";
import { shopifyGraphQL } from "@/lib/shopify/client";

/**
 * Clears the pilot so you can demo from cold. Deletes local rows and, with
 * --shopify, the tagged products in the store. Only ever touches products
 * carrying SHOPIFY_PILOT_TAG, so nothing else in the catalog is at risk.
 */

const alsoShopify = process.argv.includes("--shopify");

async function deleteTaggedProducts() {
  const query = `tag:${env.SHOPIFY_PILOT_TAG}`;
  let deleted = 0;

  for (;;) {
    const data = await shopifyGraphQL<{
      products: { nodes: Array<{ id: string; title: string }> };
    }>(
      `query Pilot($query: String!) {
         products(first: 50, query: $query) { nodes { id title } }
       }`,
      { query },
    );
    const nodes = data.products.nodes;
    if (!nodes.length) break;

    for (const node of nodes) {
      await shopifyGraphQL(
        `mutation Del($input: ProductDeleteInput!) {
           productDelete(input: $input) {
             deletedProductId
             userErrors { field message }
           }
         }`,
        { input: { id: node.id } },
      );
      deleted++;
      console.log(`  deleted  ${node.title}`);
    }
  }
  return deleted;
}

async function main() {
  if (alsoShopify) {
    if (!env.SHOPIFY_PILOT_TAG) {
      throw new Error("SHOPIFY_PILOT_TAG is empty — refusing to bulk delete.");
    }
    console.log(`\n  Deleting Shopify products tagged "${env.SHOPIFY_PILOT_TAG}"\n`);
    const n = await deleteTaggedProducts();
    console.log(`\n  ${n} product(s) removed from Shopify`);
  }

  await db.execute(sql`
    truncate sync_event, sync_run, shopify_map, fitment, product_image,
             product, brand, raw_payload restart identity cascade
  `);
  console.log("  local tables truncated\n");
  console.log(
    alsoShopify
      ? "  Pilot reset. Next: npm run sync\n"
      : "  Local data cleared. Add --shopify to also remove the store products.\n",
  );
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error("\n  Reset failed:", err instanceof Error ? err.message : err, "\n");
    await pool.end().catch(() => {});
    process.exit(1);
  });
