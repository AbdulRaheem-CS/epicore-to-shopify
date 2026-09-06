import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { env } from "@/lib/env";
import { shopifyGraphQL } from "@/lib/shopify/client";

export const dynamic = "force-dynamic";

export async function GET() {
  const health: Record<string, unknown> = {
    epicorMode: env.EPICOR_MODE,
    shopifyApiVersion: env.SHOPIFY_API_VERSION,
  };

  try {
    await db.execute(sql`select 1`);
    health.database = "ok";
  } catch (err) {
    health.database = err instanceof Error ? err.message : "error";
  }

  try {
    const data = await shopifyGraphQL<{ shop: { name: string } }>(
      `{ shop { name } }`,
    );
    health.shopify = data.shop.name;
  } catch (err) {
    health.shopify = err instanceof Error ? err.message : "error";
  }

  const ok = health.database === "ok" && typeof health.shopify === "string";
  return NextResponse.json(health, { status: ok ? 200 : 503 });
}
