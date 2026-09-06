import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  brand,
  fitment,
  product,
  productImage,
  shopifyMap,
  syncEvent,
  syncRun,
} from "@/db/schema";
import { env } from "@/lib/env";
import { RunControls } from "@/components/RunControls";

export const dynamic = "force-dynamic";

interface Row {
  id: number;
  partNumber: string;
  title: string;
  brandName: string;
  partType: string | null;
  images: number;
  fitmentRows: number;
  acesRows: number;
  sourceHash: string;
  pushedHash: string | null;
  productGid: string | null;
}

async function loadRows(): Promise<Row[]> {
  const rows = await db
    .select({
      id: product.id,
      partNumber: product.partNumber,
      title: product.title,
      partType: product.partType,
      sourceHash: product.sourceHash,
      brandName: brand.name,
      pushedHash: shopifyMap.lastPushedHash,
      productGid: shopifyMap.shopifyProductGid,
      images: sql<number>`(select count(*)::int from ${productImage} where ${productImage.productId} = ${product.id})`,
      fitmentRows: sql<number>`(select count(*)::int from ${fitment} where ${fitment.productId} = ${product.id})`,
      acesRows: sql<number>`(select count(*)::int from ${fitment} where ${fitment.productId} = ${product.id} and ${fitment.baseVehicleId} is not null)`,
    })
    .from(product)
    .innerJoin(brand, eq(product.brandId, brand.id))
    .leftJoin(shopifyMap, eq(shopifyMap.productId, product.id))
    .orderBy(brand.name, product.partNumber);
  return rows;
}

export default async function Page() {
  let rows: Row[] = [];
  let runs: Array<typeof syncRun.$inferSelect> = [];
  let events: Array<typeof syncEvent.$inferSelect> = [];
  let dbError: string | null = null;

  try {
    [rows, runs, events] = await Promise.all([
      loadRows(),
      db.select().from(syncRun).orderBy(desc(syncRun.id)).limit(12),
      db.select().from(syncEvent).orderBy(desc(syncEvent.id)).limit(14),
    ]);
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  const totalFitment = rows.reduce((n, r) => n + r.fitmentRows, 0);
  const totalImages = rows.reduce((n, r) => n + r.images, 0);
  const acesTotal = rows.reduce((n, r) => n + r.acesRows, 0);

  return (
    <main className="shell">
      <header className="masthead">
        <h1>Epicor → Shopify pilot</h1>
        <div className="facts">
          <span>
            store <b>{env.SHOPIFY_STORE || "not set"}</b>
          </span>
          <span>
            api <b>{env.SHOPIFY_API_VERSION}</b>
          </span>
          <span>
            source <b>{env.EPICOR_MODE}</b>
          </span>
        </div>
      </header>

      <RunControls />

      {dbError ? (
        <div className="empty">
          <p>Cannot reach the database.</p>
          <p style={{ fontFamily: "var(--mono)", fontSize: "0.75rem" }}>
            {dbError}
          </p>
          <ol>
            <li>
              Start Postgres: <code>npm run db:up</code>
            </li>
            <li>
              Apply the schema: <code>npm run db:push</code>
            </li>
          </ol>
        </div>
      ) : (
        <div className="columns">
          <section className="panel">
            <h2>Run history</h2>
            <p className="note">
              A cold run reads as a band of green. Every repeat run reads as
              grey, which is the no-duplicates guarantee in visual form.
            </p>

            {runs.length === 0 ? (
              <div className="empty">
                <p>No runs yet.</p>
                <ol>
                  <li>
                    Check setup: <code>npm run verify</code>
                  </li>
                  <li>Then use Run full sync above.</li>
                </ol>
              </div>
            ) : (
              <>
                <ul className="tape">
                  {runs.map((run) => (
                    <li key={run.id}>
                      <span className="runid">#{run.id}</span>
                      <div>
                        <div className="headline">
                          <span>{summarise(run.counts)}</span>
                          <time dateTime={run.startedAt.toISOString()}>
                            {run.startedAt.toISOString().slice(11, 19)}
                          </time>
                        </div>
                        <div
                          className="blocks"
                          aria-label={summarise(run.counts)}
                        >
                          {blocksFor(run.counts).map((kind, i) => (
                            <span key={i} data-kind={kind} />
                          ))}
                        </div>
                        {run.error ? (
                          <div
                            style={{
                              color: "var(--failed)",
                              fontSize: "0.75rem",
                              marginTop: "0.3rem",
                            }}
                          >
                            {run.error.slice(0, 160)}
                          </div>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="legend">
                  <span>
                    <i style={{ background: "var(--created)" }} />
                    created
                  </span>
                  <span>
                    <i style={{ background: "var(--updated)" }} />
                    updated
                  </span>
                  <span>
                    <i style={{ background: "var(--skipped)", opacity: 0.5 }} />
                    skipped
                  </span>
                </div>
              </>
            )}
          </section>

          <section className="panel">
            <h2>Pilot set</h2>
            <p className="note">
              {rows.length} part{rows.length === 1 ? "" : "s"} from{" "}
              {env.PILOT_CATEGORY} · {totalImages} images · {totalFitment}{" "}
              fitment rows
              {totalFitment > 0
                ? acesTotal === totalFitment
                  ? " with ACES vehicle ids"
                  : acesTotal === 0
                    ? " (text only, no ACES ids)"
                    : ` (${acesTotal} with ACES ids)`
                : ""}
              .
            </p>

            {rows.length === 0 ? (
              <div className="empty">
                <p>Nothing normalised yet.</p>
                <ol>
                  <li>Fetch from Epicor lands the raw payloads.</li>
                  <li>Normalize turns them into products and fitment.</li>
                  <li>Push writes them to Shopify.</li>
                </ol>
              </div>
            ) : (
              <table className="grid">
                <thead>
                  <tr>
                    <th>Part</th>
                    <th>Manufacturer</th>
                    <th className="num">Img</th>
                    <th className="num">Fits</th>
                    <th>Shopify</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const state = !row.productGid
                      ? "pending"
                      : row.pushedHash === row.sourceHash
                        ? "synced"
                        : "stale";
                    return (
                      <tr key={row.id}>
                        <td>
                          <code>{row.partNumber}</code>
                          <span className="title">{row.title}</span>
                        </td>
                        <td>
                          {row.brandName}
                          <span className="title">{row.partType ?? "—"}</span>
                        </td>
                        <td className="num">{row.images}</td>
                        <td className="num">{row.fitmentRows}</td>
                        <td>
                          <span className="chip" data-state={state}>
                            {state}
                          </span>
                          {row.productGid ? (
                            <span className="title">
                              {row.productGid.split("/").pop()}
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {events.length > 0 ? (
              <ul className="events">
                {events.map((e) => (
                  <li key={e.id} data-action={e.action}>
                    <b>{e.action}</b> {e.subject ?? ""}{" "}
                    {e.message?.startsWith("gid://")
                      ? e.message.split("/").pop()
                      : e.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        </div>
      )}
    </main>
  );
}

function summarise(counts: Record<string, number> | null): string {
  if (!counts || Object.keys(counts).length === 0) return "no changes recorded";
  const order = ["created", "updated", "skipped", "failed", "products", "requests"];
  const parts = order
    .filter((k) => counts[k] !== undefined)
    .map((k) => `${counts[k]} ${k}`);
  return parts.join(" · ") || "no changes recorded";
}

function blocksFor(counts: Record<string, number> | null): string[] {
  if (!counts) return [];
  const blocks: string[] = [];
  const push = (kind: string, n = 0) => {
    for (let i = 0; i < Math.min(n, 40); i++) blocks.push(kind);
  };
  push("created", counts.created);
  push("updated", counts.updated);
  push("skipped", counts.skipped);
  push("failed", counts.failed);
  return blocks;
}
