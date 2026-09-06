import { db } from "@/db";
import { rawPayload } from "@/db/schema";
import { env } from "@/lib/env";
import { EpicorClient } from "@/lib/epicor/client";
import { mapPart, toList } from "@/lib/epicor/mapping";
import type { EndpointName } from "@/lib/epicor/endpoints";

export interface ExtractCounts {
  requests: number;
  partsSeen: number;
  partsKept: number;
}

/**
 * Stage 1. Walks the Epicor funnel and writes every response into
 * raw_payload untouched. Nothing here interprets the data beyond what is
 * needed to pick the next request — parsing happens in normalize.
 */
export async function extract(syncRunId: number): Promise<ExtractCounts> {
  const client = new EpicorClient();
  const counts: ExtractCounts = { requests: 0, partsSeen: 0, partsKept: 0 };

  const land = async (
    endpoint: EndpointName,
    params: Record<string, string> = {},
  ) => {
    const result = await client.call(endpoint, params);
    await db.insert(rawPayload).values({
      syncRunId,
      endpoint,
      params,
      body: result.body as never,
    });
    counts.requests++;
    return result.body;
  };

  // Narrow to the pilot slice. In fixtures mode the params are recorded but
  // the saved response is returned regardless, which is what we want.
  const partsBody = await land("parts", {
    category: env.PILOT_CATEGORY,
    group: env.PILOT_GROUP,
    partType: env.PILOT_PART_TYPE,
    ...(env.PILOT_BRAND ? { brand: env.PILOT_BRAND } : {}),
  });

  const rows = toList(partsBody);
  counts.partsSeen = rows.length;

  // Pick the pilot set: optionally filter to one brand, then take the first
  // N. Sorting by part number keeps the selection stable between runs.
  const candidates = rows
    .map((row) => {
      try {
        return { row, part: mapPart(row) };
      } catch {
        return null;
      }
    })
    .filter((x): x is { row: Record<string, unknown>; part: ReturnType<typeof mapPart> } => x !== null)
    .filter((x) =>
      env.PILOT_BRAND
        ? x.part.brandName.toLowerCase() === env.PILOT_BRAND.toLowerCase()
        : true,
    )
    .sort((a, b) => a.part.partNumber.localeCompare(b.part.partNumber))
    .slice(0, env.PILOT_PART_LIMIT);

  counts.partsKept = candidates.length;

  for (const { part } of candidates) {
    const partId = part.epicorPartId ?? part.partNumber;
    // Detail, assets and fitment per part. Sequential on purpose: the pilot
    // set is 5 items and being polite to a pilot API costs nothing.
    await land("partDetail", { partId, partNumber: part.partNumber });
    await land("partAssets", { partId, partNumber: part.partNumber });
    await land("partFitment", { partId, partNumber: part.partNumber });
  }

  return counts;
}
