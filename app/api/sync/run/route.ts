import { NextResponse } from "next/server";
import { ALL_STAGES, runSync, type Stage } from "@/lib/sync/run";

export const maxDuration = 300;

export async function POST(request: Request) {
  let stages: Stage[] = ALL_STAGES;

  try {
    const body = await request.json();
    if (Array.isArray(body?.stages) && body.stages.length) {
      stages = body.stages.filter((s: string): s is Stage =>
        (ALL_STAGES as string[]).includes(s),
      );
    }
  } catch {
    // No body means run everything.
  }

  if (!stages.length) {
    return NextResponse.json(
      { status: "error", error: `stages must be a subset of ${ALL_STAGES.join(", ")}` },
      { status: 400 },
    );
  }

  const result = await runSync(stages);
  return NextResponse.json(result, {
    status: result.status === "error" ? 500 : 200,
  });
}
