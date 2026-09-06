import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { syncRun } from "@/db/schema";

export const dynamic = "force-dynamic";

export async function GET() {
  const runs = await db
    .select()
    .from(syncRun)
    .orderBy(desc(syncRun.id))
    .limit(50);
  return NextResponse.json({ runs });
}
