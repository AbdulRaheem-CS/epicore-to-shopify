import "dotenv/config";
import { pool } from "@/db";
import { ALL_STAGES, runSync, type Stage } from "@/lib/sync/run";

function parseStages(): Stage[] {
  const idx = process.argv.indexOf("--only");
  if (idx === -1) return ALL_STAGES;
  const requested = process.argv[idx + 1]?.split(",") ?? [];
  const valid = requested.filter((s): s is Stage =>
    (ALL_STAGES as string[]).includes(s),
  );
  if (!valid.length) {
    console.error(`--only expects one of: ${ALL_STAGES.join(", ")}`);
    process.exit(1);
  }
  return valid;
}

const stages = parseStages();

console.log(`\n  Sync starting — stages: ${stages.join(" → ")}\n`);

runSync(stages)
  .then(async (result) => {
    const rows = Object.entries(result.counts);
    const width = Math.max(12, ...rows.map(([k]) => k.length)) + 2;

    console.log(`  run #${result.runId}  ${result.status.toUpperCase()}  ${result.durationMs}ms\n`);
    for (const [key, value] of rows) {
      console.log(`  ${key.padEnd(width)}${value}`);
    }
    if (result.fitmentGrade) {
      console.log(`  ${"fitment data".padEnd(width)}${result.fitmentGrade}`);
      if (result.fitmentGrade === "text-only") {
        console.log(
          `\n  Note: Epicor returned no ACES BaseVehicleID values. Vehicle\n` +
            `  matching later will be string-based. Worth raising with Epicor.`,
        );
      }
    }
    if (result.error) console.log(`\n  Error: ${result.error}`);
    console.log("");
    await pool.end();
    process.exit(result.status === "ok" ? 0 : 1);
  })
  .catch(async (err) => {
    console.error("\n  Sync crashed:", err instanceof Error ? err.message : err, "\n");
    await pool.end().catch(() => {});
    process.exit(1);
  });
