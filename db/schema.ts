import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Landing zone. Every Epicor response is stored verbatim before anything
 * parses it. This is what lets you replay a bad transform without going
 * back to Epicor, and it is the difference between scaling to the full CCL
 * and rewriting the pipeline later.
 */
export const rawPayload = pgTable(
  "raw_payload",
  {
    id: serial("id").primaryKey(),
    syncRunId: integer("sync_run_id"),
    endpoint: text("endpoint").notNull(),
    params: jsonb("params").$type<Record<string, unknown>>(),
    body: jsonb("body").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("raw_payload_endpoint_idx").on(t.endpoint)],
);

/**
 * In the aftermarket a part number is only unique WITHIN a brand. The same
 * number exists across manufacturers, so brand is half of the natural key.
 */
export const brand = pgTable(
  "brand",
  {
    id: serial("id").primaryKey(),
    aaiaBrandId: text("aaia_brand_id"),
    name: text("name").notNull(),
    lineCode: text("line_code"),
  },
  (t) => [uniqueIndex("brand_name_uq").on(t.name)],
);

export const product = pgTable(
  "product",
  {
    id: serial("id").primaryKey(),
    brandId: integer("brand_id")
      .notNull()
      .references(() => brand.id),
    partNumber: text("part_number").notNull(),
    epicorProductId: text("epicor_product_id"),
    category: text("category"),
    groupName: text("group_name"),
    partType: text("part_type"),
    title: text("title").notNull(),
    description: text("description"),
    attributes: jsonb("attributes").$type<Record<string, unknown>>(),
    /** SHA-256 over normalised product + fitment + image checksums. */
    sourceHash: text("source_hash").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // THE constraint that makes duplicates impossible at rest.
    uniqueIndex("product_brand_part_uq").on(t.brandId, t.partNumber),
    index("product_part_type_idx").on(t.partType),
  ],
);

export const productImage = pgTable(
  "product_image",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "cascade" }),
    sourceUrl: text("source_url").notNull(),
    /** Stable digest of the source URL (or bytes, once downloaded). */
    checksum: text("checksum").notNull(),
    position: integer("position").notNull().default(0),
    altText: text("alt_text"),
    shopifyMediaId: text("shopify_media_id"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
  },
  (t) => [
    // Stops image counts doubling on every re-run.
    uniqueIndex("product_image_uq").on(t.productId, t.checksum),
  ],
);

export const fitment = pgTable(
  "fitment",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "cascade" }),
    /** ACES BaseVehicleID when Epicor gives it to us. Null means text-only. */
    baseVehicleId: text("base_vehicle_id"),
    year: integer("year"),
    make: text("make"),
    model: text("model"),
    submodel: text("submodel"),
    engine: text("engine"),
    qualifier: text("qualifier"),
    /**
     * Digest of the identifying fields above. Postgres treats NULLs as
     * distinct in unique indexes, so hashing sidesteps the whole problem.
     */
    fitmentKey: text("fitment_key").notNull(),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
  },
  (t) => [
    uniqueIndex("fitment_uq").on(t.productId, t.fitmentKey),
    index("fitment_vehicle_idx").on(t.year, t.make, t.model),
  ],
);

/**
 * Local record of what exists in Shopify. This is the primary defence against
 * duplicates; the epicor.part_key metafield is the backup if this table is
 * ever restored from an old snapshot.
 */
export const shopifyMap = pgTable("shopify_map", {
  productId: integer("product_id")
    .primaryKey()
    .references(() => product.id, { onDelete: "cascade" }),
  shopifyProductGid: text("shopify_product_gid").notNull(),
  shopifyVariantGid: text("shopify_variant_gid"),
  partKey: text("part_key").notNull(),
  lastPushedHash: text("last_pushed_hash"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
});

export const syncRun = pgTable("sync_run", {
  id: serial("id").primaryKey(),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  status: text("status").notNull().default("running"),
  stages: jsonb("stages").$type<string[]>(),
  scope: jsonb("scope").$type<Record<string, unknown>>(),
  counts: jsonb("counts").$type<Record<string, number>>(),
  error: text("error"),
});

export const syncEvent = pgTable(
  "sync_event",
  {
    id: serial("id").primaryKey(),
    syncRunId: integer("sync_run_id")
      .notNull()
      .references(() => syncRun.id, { onDelete: "cascade" }),
    productId: integer("product_id"),
    stage: text("stage").notNull(),
    /** created | updated | skipped | failed */
    action: text("action").notNull(),
    subject: text("subject"),
    message: text("message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("sync_event_run_idx").on(t.syncRunId)],
);

export type Product = typeof product.$inferSelect;
export type Brand = typeof brand.$inferSelect;
export type Fitment = typeof fitment.$inferSelect;
export type ProductImage = typeof productImage.$inferSelect;
export type SyncRun = typeof syncRun.$inferSelect;
export type SyncEvent = typeof syncEvent.$inferSelect;
export type ShopifyMap = typeof shopifyMap.$inferSelect;
