import "dotenv/config";
import { pool } from "@/db";
import { ensureDefinitions } from "@/lib/shopify/metafields";

console.log("\n  Creating product metafield definitions\n");

ensureDefinitions()
  .then(async (results) => {
    for (const r of results) {
      const name = `${r.namespace}.${r.key}`;
      const unique =
        r.uniqueValues === undefined
          ? ""
          : r.uniqueValues
            ? "  unique: on"
            : "  unique: OFF";
      console.log(
        `  ${r.status.toUpperCase().padEnd(10)}${name.padEnd(24)}${(
          r.type ?? ""
        ).padEnd(22)}${unique}${r.message ? `  ${r.message}` : ""}`,
      );
    }

    const partKey = results.find((r) => r.key === "part_key");
    if (partKey && partKey.uniqueValues === false) {
      console.log(
        `\n  The part_key definition exists but unique values is OFF. The\n` +
          `  customId upsert needs it. Enable it in Settings > Custom data >\n` +
          `  Products > Epicor part key, or delete the definition and re-run.`,
      );
    }
    console.log("");
    await pool.end();
    process.exit(results.some((r) => r.status === "failed") ? 1 : 0);
  })
  .catch(async (err) => {
    console.error("\n  Failed:", err instanceof Error ? err.message : err, "\n");
    await pool.end().catch(() => {});
    process.exit(1);
  });
