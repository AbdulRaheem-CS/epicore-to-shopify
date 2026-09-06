import { desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { rawPayload, syncRun } from "@/db/schema";
import { env } from "@/lib/env";
import { extract } from "./extract";
import { normalize } from "./normalize";
import { push } from "./push";

export type Stage = "extract" | "normalize" | "push";
export const ALL_STAGES: Stage[] = ["extract", "normalize", "push"];

export interface RunResult {
  runId: number;
  status: "ok" | "partial" | "error";
  stages: Stage[];
  counts: Record<string, number>;
  fitmentGrade?: string;
  error?: string;
  durationMs: number;
}

export async function runSync(stages: Stage[] = ALL_STAGES): Promise<RunResult> {
  const startedAt = Date.now();

  const [run] = await db
    .insert(syncRun)
    .values({
      status: "running",
      stages,
      scope: {
        mode: env.EPICOR_MODE,
        category: env.PILOT_CATEGORY,
        group: env.PILOT_GROUP,
        partType: env.PILOT_PART_TYPE,
        brand: env.PILOT_BRAND || null,
        limit: env.PILOT_PART_LIMIT,
      },
    })
    .returning();

  const counts: Record<string, number> = {};
  let fitmentGrade: string | undefined;

  try {
    if (stages.includes("extract")) {
      const c = await extract(run.id);
      Object.assign(counts, {
        requests: c.requests,
        partsSeen: c.partsSeen,
        partsKept: c.partsKept,
      });
    }

    if (stages.includes("normalize")) {
      // When normalize runs without extract, use the newest run that has
      // raw payloads so the stage can be re-run in isolation.
      const sourceRunId = stages.includes("extract")
        ? run.id
        : await latestRunWithPayloads(run.id);
      const c = await normalize(sourceRunId);
      Object.assign(counts, {
        products: c.products,
        images: c.images,
        fitmentRows: c.fitmentRows,
        incomplete: c.incomplete,
      });
      fitmentGrade = c.fitmentGrade;
    }

    if (stages.includes("push")) {
      const c = await push(run.id);
      Object.assign(counts, {
        created: c.created,
        updated: c.updated,
        skipped: c.skipped,
        failed: c.failed,
        imagesUploaded: c.imagesUploaded,
      });
    }

    const failed = counts.failed ?? 0;

    await db
      .update(syncRun)
      .set({
        status: failed ? "partial" : "ok",
        finishedAt: new Date(),
        counts,
      })
      .where(eq(syncRun.id, run.id));

    return {
      runId: run.id,
      status: failed ? "partial" : "ok",
      stages,
      counts,
      fitmentGrade,
      error: failed ? `${failed} product(s) failed — see sync_event` : undefined,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(syncRun)
      .set({
        status: "error",
        finishedAt: new Date(),
        counts,
        error: message.slice(0, 2000),
      })
      .where(eq(syncRun.id, run.id));

    return {
      runId: run.id,
      status: "error",
      stages,
      counts,
      error: message,
      durationMs: Date.now() - startedAt,
    };
  }
}

async function latestRunWithPayloads(fallback: number): Promise<number> {
  const rows = await db
    .select({ syncRunId: rawPayload.syncRunId })
    .from(rawPayload)
    .where(isNotNull(rawPayload.syncRunId))
    .orderBy(desc(rawPayload.syncRunId))
    .limit(1);
  return rows[0]?.syncRunId ?? fallback;
}
