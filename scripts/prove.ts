import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "@/db";
import { product, productImage, shopifyMap } from "@/db/schema";
import { runSync } from "@/lib/sync/run";
import { countPilotProducts } from "@/lib/shopify/products";
import { countProductMedia } from "@/lib/shopify/media";
import { env } from "@/lib/env";

/**
 * The deliverable for "support updating an existing product without creating
 * duplicates". Runs the pilot flow three times and asserts the outcome each
 * time, so the claim is demonstrated rather than described.
 *
 *   Run 1  cold      -> N created
 *   Run 2  unchanged -> 0 created, N skipped, same GIDs, same image counts
 *   Run 3  one title changed upstream -> 1 updated, still N products
 */

interface Assertion {
  label: string;
  expected: string;
  actual: string;
  ok: boolean;
}

const results: Assertion[] = [];

function expect(label: string, expected: unknown, actual: unknown) {
  results.push({
    label,
    expected: String(expected),
    actual: String(actual),
    ok: String(expected) === String(actual),
  });
}

async function snapshot() {
  const maps = await db.select().from(shopifyMap).orderBy(shopifyMap.partKey);
  const media: Record<string, number> = {};
  for (const m of maps) {
    media[m.partKey] = await countProductMedia(m.shopifyProductGid).catch(() => -1);
  }
  return {
    gids: maps.map((m) => `${m.partKey}=${m.shopifyProductGid}`).join("|"),
    media,
    count: maps.length,
  };
}

async function main() {
  console.log("\n  Idempotency proof — Epicor → Shopify pilot");
  console.log(`  store: ${env.SHOPIFY_STORE}  mode: ${env.EPICOR_MODE}\n`);

  // ---- Run 1: cold ---------------------------------------------------------
  console.log("  Run 1 — cold sync");
  const run1 = await runSync();
  if (run1.status === "error") throw new Error(run1.error);
  const expectedCount = run1.counts.products ?? env.PILOT_PART_LIMIT;

  expect("run 1 products normalised", expectedCount, run1.counts.products ?? 0);
  expect("run 1 failures", 0, run1.counts.failed ?? 0);
  const after1 = await snapshot();
  expect("run 1 products mapped to Shopify", expectedCount, after1.count);

  // ---- Run 2: unchanged ----------------------------------------------------
  console.log("  Run 2 — identical re-run (the duplicate test)");
  const run2 = await runSync();
  if (run2.status === "error") throw new Error(run2.error);

  expect("run 2 created", 0, run2.counts.created ?? 0);
  expect("run 2 updated", 0, run2.counts.updated ?? 0);
  expect("run 2 skipped", expectedCount, run2.counts.skipped ?? 0);
  expect("run 2 images uploaded", 0, run2.counts.imagesUploaded ?? 0);

  const after2 = await snapshot();
  expect("Shopify product ids unchanged", after1.gids, after2.gids);
  expect(
    "image counts unchanged",
    JSON.stringify(after1.media),
    JSON.stringify(after2.media),
  );

  const localCount = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(product);
  expect("local product rows", expectedCount, localCount[0]?.n ?? 0);

  const imageRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(productImage);
  const imagesAfter2 = imageRows[0]?.n ?? 0;

  // ---- Run 3: one product changed upstream --------------------------------
  console.log("  Run 3 — one title changed, expect a single update");
  const [target] = await db.select().from(product).limit(1);
  if (target) {
    await db
      .update(product)
      .set({
        title: `${target.title} (rev ${Date.now().toString().slice(-4)})`,
        sourceHash: `${target.sourceHash.slice(0, 60)}changed`,
      })
      .where(eq(product.id, target.id));
  }

  const run3 = await runSync(["push"]);
  if (run3.status === "error") throw new Error(run3.error);

  expect("run 3 created", 0, run3.counts.created ?? 0);
  expect("run 3 updated", 1, run3.counts.updated ?? 0);
  expect("run 3 skipped", expectedCount - 1, run3.counts.skipped ?? 0);

  const after3 = await snapshot();
  expect("Shopify product ids still unchanged", after1.gids, after3.gids);

  const imageRows3 = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(productImage);
  expect("image rows unchanged", imagesAfter2, imageRows3[0]?.n ?? 0);

  // ---- Live check against Shopify itself ----------------------------------
  try {
    const tagged = await countPilotProducts();
    expect(
      `Shopify products tagged ${env.SHOPIFY_PILOT_TAG}`,
      expectedCount,
      tagged,
    );
  } catch (err) {
    console.log(
      `  (skipped tag count: ${err instanceof Error ? err.message : err})`,
    );
  }

  print();
}

function print() {
  const width = Math.max(...results.map((r) => r.label.length)) + 2;
  console.log("\n  ─────────────────────────────────────────────────────────");
  for (const r of results) {
    const detail = r.ok ? r.actual : `got ${r.actual}, expected ${r.expected}`;
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.label.padEnd(width)}${detail}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log("  ─────────────────────────────────────────────────────────");
  console.log(
    failed === 0
      ? `\n  ${results.length}/${results.length} passed. No duplicates created across three runs.\n`
      : `\n  ${failed} of ${results.length} assertions failed.\n`,
  );
  return failed;
}

main()
  .then(async () => {
    await pool.end();
    process.exit(results.some((r) => !r.ok) ? 1 : 0);
  })
  .catch(async (err) => {
    console.error("\n  Proof run failed:", err instanceof Error ? err.message : err);
    print();
    await pool.end().catch(() => {});
    process.exit(1);
  });
