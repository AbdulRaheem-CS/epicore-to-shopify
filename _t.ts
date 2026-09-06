import "dotenv/config";
import { db, pool } from "@/db";
import { shopifyMap } from "@/db/schema";
import { findMissingProducts } from "@/lib/shopify/products";
const maps = await db.select().from(shopifyMap).orderBy(shopifyMap.partKey);
const gids = maps.map((m) => m.shopifyProductGid);
console.log("map rows:", maps.length);
const missing = await findMissingProducts(gids);
for (const m of maps)
  console.log(`  ${m.partKey.padEnd(16)} ${m.shopifyProductGid.split("/").pop()}  ${missing.has(m.shopifyProductGid) ? "MISSING" : "exists"}`);
console.log("findMissingProducts ->", missing.size, "missing");
await pool.end();
