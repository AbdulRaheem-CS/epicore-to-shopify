import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "@/db";
import { env, METAFIELDS } from "@/lib/env";
import { shopifyGraphQL } from "@/lib/shopify/client";
import { listDefinitions } from "@/lib/shopify/metafields";
import { EpicorClient } from "@/lib/epicor/client";
import { ENDPOINTS } from "@/lib/epicor/endpoints";

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const add = (name: string, ok: boolean, detail: string) =>
  checks.push({ name, ok, detail });

async function main() {
  // 1. Environment
  add(
    "DATABASE_URL set",
    Boolean(env.DATABASE_URL),
    env.DATABASE_URL ? mask(env.DATABASE_URL) : "missing",
  );
  add(
    "SHOPIFY_STORE set",
    Boolean(env.SHOPIFY_STORE),
    env.SHOPIFY_STORE || "missing",
  );
  add(
    "SHOPIFY_TOKEN set",
    env.SHOPIFY_TOKEN.startsWith("shpat_"),
    env.SHOPIFY_TOKEN
      ? `${env.SHOPIFY_TOKEN.slice(0, 9)}…`
      : "missing — Settings > Apps > Develop apps > API credentials",
  );
  add("API version pinned", /^\d{4}-\d{2}$/.test(env.SHOPIFY_API_VERSION), env.SHOPIFY_API_VERSION);

  // 2. Database
  try {
    await db.execute(sql`select 1`);
    const tables = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from information_schema.tables where table_schema = 'public'`,
    );
    const count = (tables as unknown as { rows: Array<{ count: string }> })
      .rows[0]?.count;
    add("Postgres reachable", true, `${count ?? "?"} tables in public schema`);
    add(
      "Schema applied",
      Number(count ?? 0) >= 7,
      Number(count ?? 0) >= 7
        ? "all pilot tables present"
        : "run: npm run db:push",
    );
  } catch (err) {
    add(
      "Postgres reachable",
      false,
      `${msg(err)} — is docker compose up? (npm run db:up)`,
    );
  }

  // 3. Shopify auth
  if (env.SHOPIFY_TOKEN && env.SHOPIFY_STORE) {
    try {
      const data = await shopifyGraphQL<{
        shop: { name: string; myshopifyDomain: string };
      }>(`{ shop { name myshopifyDomain } }`);
      add("Shopify auth", true, `${data.shop.name} (${data.shop.myshopifyDomain})`);
    } catch (err) {
      add("Shopify auth", false, msg(err));
    }

    // 4. Metafield definitions
    try {
      const partKeyDefs = await listDefinitions(METAFIELDS.partKey.namespace);
      const partKey = partKeyDefs.find((d) => d.key === METAFIELDS.partKey.key);
      add(
        `metafield ${METAFIELDS.partKey.namespace}.${METAFIELDS.partKey.key}`,
        Boolean(partKey),
        partKey ? `type ${partKey.type.name}` : "missing — npm run setup:metafields",
      );
      // Shopify rejects identifier.customId against anything but type "id",
      // and it fails at push time, not at definition time — so assert it here.
      add(
        "part_key type is id",
        partKey?.type.name === "id",
        partKey?.type.name === "id"
          ? "required for identifier.customId"
          : `is "${partKey?.type.name ?? "missing"}" — customId upsert will ` +
            `fail with "Metafield definition of type 'id' is required". ` +
            `Re-run npm run setup:metafields`,
      );
      add(
        "part_key unique values enabled",
        Boolean(partKey?.capabilities?.uniqueValues?.enabled),
        partKey?.capabilities?.uniqueValues?.enabled
          ? "customId upsert will work"
          : "REQUIRED for duplicate-free upsert — npm run setup:metafields",
      );

      const fitmentDefs = await listDefinitions(METAFIELDS.fitment.namespace);
      const fit = fitmentDefs.find((d) => d.key === METAFIELDS.fitment.key);
      add(
        `metafield ${METAFIELDS.fitment.namespace}.${METAFIELDS.fitment.key}`,
        Boolean(fit),
        fit ? `type ${fit.type.name}` : "missing — npm run setup:metafields",
      );
    } catch (err) {
      add("Metafield definitions", false, msg(err));
    }
  }

  // 5. Epicor
  add("EPICOR_MODE", true, env.EPICOR_MODE);
  const placeholders = Object.entries(ENDPOINTS).filter(
    ([, spec]) => spec.placeholder,
  );
  if (env.EPICOR_MODE === "live") {
    add(
      "Epicor endpoints filled in",
      placeholders.length === 0,
      placeholders.length
        ? `${placeholders.length} still placeholders: ${placeholders
            .map(([n]) => n)
            .join(", ")}`
        : "all confirmed",
    );
    try {
      const client = new EpicorClient("live");
      await client.call("parts", {
        category: env.PILOT_CATEGORY,
        partType: env.PILOT_PART_TYPE,
      });
      add("Epicor parts call", true, "responded");
    } catch (err) {
      add("Epicor parts call", false, msg(err));
    }
  } else {
    try {
      const client = new EpicorClient("fixtures");
      const { body } = await client.call("parts");
      const size = JSON.stringify(body).length;
      add("Fixtures readable", true, `parts.json ${size} bytes`);
    } catch (err) {
      add("Fixtures readable", false, msg(err));
    }
  }

  report();
}

function report() {
  const width = Math.max(...checks.map((c) => c.name.length)) + 2;
  console.log("\n  Epicor → Shopify pilot: setup check\n");
  for (const c of checks) {
    console.log(
      `  ${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(width)}${c.detail}`,
    );
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(
    `\n  ${checks.length - failed.length}/${checks.length} passed\n`,
  );
  if (failed.length) {
    console.log("  Fix the FAIL rows above, then re-run: npm run verify\n");
  } else {
    console.log("  Ready. Next: npm run sync\n");
  }
  return failed.length;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 160);
const mask = (url: string) => url.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@");

main()
  .then(() => pool.end())
  .then(() => process.exit(checks.some((c) => !c.ok) ? 1 : 0))
  .catch(async (err) => {
    console.error("\n  Setup check crashed:", err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
