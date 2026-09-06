# Epicor → Shopify pilot

Middleware that pulls a narrow slice of the Epicor automotive catalog
(one category, one product line, 5 parts), stores it in Postgres, and pushes
it into Shopify — with re-runs that **update rather than duplicate**.

Scope is deliberately small: no full catalog sync, no EPN price/inventory,
no storefront vehicle search. The point is to prove the flow works end to end
and that the structure scales to the full licensed CCL without a rewrite.

**Status:** running green against a live Shopify store on fixture data.
`npm run prove` passes 16/16 assertions across three consecutive runs.

---

## Walkthrough script

For the recorded demo. Four beats, roughly a minute each.

| Time | Say | Show |
|---|---|---|
| **0:00** | "Epicor on one side, Shopify on the other, our middleware in between. Postgres is the source of truth, so we can replay anything without re-hitting Epicor." | [Pipeline](#pipeline), then `npm run verify` — 13/13 |
| **1:00** | "Three independently re-runnable stages. Extract stores the raw response untouched, normalize maps it into real tables, push sends only what changed." | [extract.ts:19](lib/sync/extract.ts#L19), [normalize.ts:40](lib/sync/normalize.ts#L40), [push.ts:32](lib/sync/push.ts#L32) |
| **2:00** | "The no-duplicates requirement. Four independent layers, so no single mistake produces a second product." | [Four layers](#where-the-guarantee-actually-lives), then `npm run prove` |
| **3:00** | "Today it's 5 parts on a manual command. Here's exactly what changes for the full CCL — and none of it touches the mapping or hashing logic." | [Trial → production](#trial--production) |

The single most persuasive thing to show is `npm run prove` finishing with
`16/16 passed. No duplicates created across three runs.`

---

## Quick start

The whole pipeline runs today, before Epicor grants API access, because it
ships with sample payloads.

```bash
cp .env.example .env      # then paste your Shopify token in
npm install
npm run db:up             # Postgres via docker compose
npm run db:push           # create the tables
npm run verify            # env, DB, Shopify auth, metafield definitions
npm run setup:metafields  # creates epicor.part_key + fitment.*
npm run sync              # extract → normalize → push
npm run dev               # console at http://localhost:3000
```

`npm run sync` with `EPICOR_MODE=fixtures` (the default) reads `fixtures/*.json`
instead of calling Epicor. Everything downstream is identical, so the Shopify
half is fully exercised on day one.

Running Postgres natively instead of Docker (`brew install postgresql@16`)
works too — create a `postgres` role and an `epicor_pilot` database and the
default `DATABASE_URL` needs no edit. Note that `npm run db:push` opens an
interactive confirmation prompt; `npx drizzle-kit push --force` is the
non-interactive equivalent.

### Prove the no-duplicates requirement

```bash
npm run prove
```

Runs the flow three times and asserts the outcome — [prove.ts:56](scripts/prove.ts#L56),
[:67](scripts/prove.ts#L67), [:95](scripts/prove.ts#L95):

| Run | Expected |
|-----|----------|
| 1 — cold | 5 products created and mapped |
| 2 — identical re-run | 0 created, 0 updated, 5 skipped, same product ids, same image counts |
| 3 — one title changed | 1 updated, 4 skipped, still 5 products |

This is the deliverable for *"support updating an existing product without
creating duplicates."* It exits non-zero if any assertion fails, so it can go
straight into CI.

---

## Pipeline

```
Epicor ──▶ raw_payload (JSONB, verbatim) ──▶ normalized tables ──▶ Shopify
           extract                          normalize              push
```

Each stage is independently re-runnable (`npm run sync:extract` etc.), wired up
in [run.ts:22](lib/sync/run.ts#L22).

| Stage | File | Does |
|---|---|---|
| extract | [extract.ts:19](lib/sync/extract.ts#L19) | Calls Epicor, writes every response verbatim to `raw_payload` [:28](lib/sync/extract.ts#L28) |
| normalize | [normalize.ts:40](lib/sync/normalize.ts#L40) | Maps raw JSON into `brand` / `product` / `product_image` / `fitment`, computes `source_hash` [:105](lib/sync/normalize.ts#L105) |
| push | [push.ts:32](lib/sync/push.ts#L32) | Compares hashes, upserts changed products into Shopify, uploads media |

The `raw_payload` landing table is kept even at 5 products. It lets you replay
a bad transform without re-hitting Epicor, and it is the difference between
scaling to the full CCL and rewriting the pipeline.

### Tables — [db/schema.ts](db/schema.ts)

| Table | Line | Purpose |
|---|---|---|
| `raw_payload` | [:18](db/schema.ts#L18) | Every Epicor response, untouched. Append-only audit trail. |
| `brand` | [:37](db/schema.ts#L37) | Manufacturer / line. Half of the natural key. |
| `product` | [:48](db/schema.ts#L48) | One row per part. Carries `source_hash`. |
| `product_image` | [:79](db/schema.ts#L79) | Source URL, checksum, Shopify media id. |
| `fitment` | [:100](db/schema.ts#L100) | One row per vehicle application, ACES ids when available. |
| `shopify_map` | [:133](db/schema.ts#L133) | Local record of Shopify product/variant GIDs. |
| `sync_run` / `sync_event` | [:144](db/schema.ts#L144) / [:157](db/schema.ts#L157) | Run counts and per-product outcomes. |

---

## Where the guarantee actually lives

Four independent layers, so no single mistake produces a duplicate.

**1. The natural key is brand + part number, not SKU.** In the aftermarket the
same part number exists across manufacturers, and Shopify does not enforce SKU
uniqueness. `product` has a unique index on `(brand_id, part_number)` —
[schema.ts:74](db/schema.ts#L74). `part_key` is derived as
`BRANDCODE::PARTNUMBER`, uppercased and stripped of punctuation —
[push.ts:216](lib/sync/push.ts#L216).

**2. Database constraints, not application logic.** Unique indexes on
`product(brand_id, part_number)` [:74](db/schema.ts#L74),
`product_image(product_id, checksum)` [:96](db/schema.ts#L96) and
`fitment(product_id, fitment_key)` [:123](db/schema.ts#L123). Re-running
normalize is inert *by construction* rather than by remembering to check first —
see the `onConflictDoUpdate` / `onConflictDoNothing` clauses at
[normalize.ts:132](lib/sync/normalize.ts#L132), [:159](lib/sync/normalize.ts#L159)
and [:180](lib/sync/normalize.ts#L180).

**3. A content hash gates the push.** Each product carries a `source_hash` —
SHA-256 over its fields, spec rows, sorted fitment keys and sorted image
checksums ([normalize.ts:105](lib/sync/normalize.ts#L105), hashing in
[hash.ts:8](lib/hash.ts#L8)). If it matches `shopify_map.last_pushed_hash` the
product is skipped *before any network call is made* —
[push.ts:63](lib/sync/push.ts#L63). Verified: a skip run makes zero Shopify
requests.

**4. Shopify-side upsert by identifier.** `productSet` with
`identifier.customId` pointing at the `epicor.part_key` metafield —
[products.ts:180](lib/shopify/products.ts#L180). Shopify resolves
create-vs-update itself, so even a restored-from-backup database converges on
the existing product instead of creating a second one. A lookup failure is
recorded as a failed event and never falls through to a create —
[products.ts:104](lib/shopify/products.ts#L104).

> Layer 4 was exercised for real during the build, not just in theory. A run
> created all 5 products in Shopify but crashed before writing `shopify_map`,
> leaving the local database with no record of them. The next run found all
> five by `part_key` and updated them. Zero duplicates.

---

## Field mapping

The agreed Epicor → Shopify mapping, and where each side is implemented.

| Shopify | Epicor source | Built in |
|---|---|---|
| Title | Manufacturer + Part Number + short part description | [`buildTitle`, mapping.ts:203](lib/epicor/mapping.ts#L203) |
| SKU | Line Code (or brand) + Part Number, e.g. `NORTH-NF-51515` | [`buildSku`, push.ts:204](lib/sync/push.ts#L204) |
| Vendor | Epicor Manufacturer name | [push.ts:94](lib/sync/push.ts#L94) |
| Description | Part description + extended attributes as a spec table | [`buildDescriptionHtml`, mapping.ts:336](lib/epicor/mapping.ts#L336) |
| Images | Part asset URLs, uploaded as product media | [`uploadProductImage`, media.ts:67](lib/shopify/media.ts#L67) |
| Fitment | `fitment.applications` (JSON) + `fitment.summary` (text) metafields | [`fitmentMetafields`, products.ts:239](lib/shopify/products.ts#L239) |
| Price / Inventory | Not mapped — out of pilot scope | — |

**Two notes on the title.** Epicor's `LongDescription` is a marketing sentence
and it is mapped to the Shopify description, so the title uses the short form —
part type, else `PartTypeDescription`, with `LongDescription` only as a last
resort. And because the short form usually already repeats the brand and the
part number, each prefix is added only when it isn't already in the text
([mapping.ts:218](lib/epicor/mapping.ts#L218)) — otherwise every title reads
*"Northline Filtration NF-51515 Northline Filtration Oil Filter NF-51515"*.

**SKU is deliberately not the same string as `part_key`.** `part_key`
(`BRANDCODE::PARTNUMBER`) is the upsert identity and must never change shape;
SKU is merchant-facing text. Extended attributes feed `source_hash` as well as
the description ([normalize.ts:105](lib/sync/normalize.ts#L105)), so an
attribute change on its own is enough to trigger a re-push.

**Extended attributes** arrive from Epicor as an `Attributes: [{Name, Value}]`
array rather than flat keys. [`specRows`, mapping.ts:276](lib/epicor/mapping.ts#L276)
reads that array *and* useful scalars on the part row, filters out ids, URLs,
counts and already-mapped columns, then sorts — the output feeds a hash, so an
unstable order there would re-push every product on every run.

---

## Code map

| File | Line | Responsibility |
|---|---|---|
| [lib/epicor/endpoints.ts](lib/epicor/endpoints.ts) | [:44](lib/epicor/endpoints.ts#L44) | `ENDPOINTS` — every Epicor path in one place. **The only file to edit for the real API.** |
| | [:115](lib/epicor/endpoints.ts#L115) | `FIELD_CANDIDATES` — candidate field names probed per logical field |
| [lib/epicor/client.ts](lib/epicor/client.ts) | [:28](lib/epicor/client.ts#L28) | Fixtures-vs-live switch; token handling at [:168](lib/epicor/client.ts#L168) |
| [lib/epicor/mapping.ts](lib/epicor/mapping.ts) | [:42](lib/epicor/mapping.ts#L42) | `toList` — finds the array whatever key it hides under |
| | [:83](lib/epicor/mapping.ts#L83) | `unwrap` — descends wrapper objects like `{ "Item": {...} }` |
| | [:157](lib/epicor/mapping.ts#L157) | `mapPart` — Epicor row → normalised part |
| | [:394](lib/epicor/mapping.ts#L394) | `mapFitment`; `fitmentQuality` at [:419](lib/epicor/mapping.ts#L419) grades ACES coverage |
| [lib/sync/run.ts](lib/sync/run.ts) | [:22](lib/sync/run.ts#L22) | Stage orchestration, run records, counts |
| [lib/shopify/client.ts](lib/shopify/client.ts) | [:35](lib/shopify/client.ts#L35) | GraphQL transport + cost-aware rate limiting [:74](lib/shopify/client.ts#L74) |
| | [:109](lib/shopify/client.ts#L109) | `assertNoUserErrors` — treats `userErrors` as failures |
| [lib/shopify/products.ts](lib/shopify/products.ts) | [:133](lib/shopify/products.ts#L133) | `upsertProduct` — the create-vs-update decision |
| [lib/shopify/metafields.ts](lib/shopify/metafields.ts) | [:13](lib/shopify/metafields.ts#L13) | `DEFINITIONS` — the metafield contract |
| [scripts/verify-setup.ts](scripts/verify-setup.ts) | — | 13 preflight checks; fails loudly rather than at push time |
| [scripts/prove.ts](scripts/prove.ts) | [:38](scripts/prove.ts#L38) | Snapshots GIDs + media counts between runs |

The mapper probes several candidate names per field and falls back to a
case-insensitive match, so it tolerates casing differences between endpoints.
When it can't find a field it throws with the list of keys that *were* present
([mapping.ts:146](lib/epicor/mapping.ts#L146)), which points straight at the fix.

---

## Connecting the real Epicor API

Only one file needs editing: **[lib/epicor/endpoints.ts](lib/epicor/endpoints.ts)**.

1. Open the pilot portal in Chrome, DevTools → Network → filter `Fetch/XHR` →
   tick **Preserve log**.
2. Click through slowly: Category → Group and Part Types → Part Types →
   **Get parts** → a single part → **Buyers Guide** tab.
3. For each request: right-click → *Copy as cURL*. Save the response body to
   `fixtures/captured/<name>.json` (gitignored — it may contain licensed
   catalog data).
4. Transcribe the path, method and query params into `ENDPOINTS`
   ([:44](lib/epicor/endpoints.ts#L44)) and clear the `placeholder: true` flag
   on each one you've confirmed ([:41](lib/epicor/endpoints.ts#L41)).
5. Add the real field names to the front of the relevant `FIELD_CANDIDATES`
   list ([:115](lib/epicor/endpoints.ts#L115)).
6. Set `EPICOR_MODE=live` and `npm run verify` — it reports how many endpoints
   are still placeholders and makes one live `parts` call.

All 8 endpoints are currently placeholders, so live mode needs the capture
before credentials are any use.

### Still to confirm with Epicor

- **Does fitment include ACES `BaseVehicleID`, or only year/make/model text?**
  The sync reports this after every run (`fitment data: aces | partial |
  text-only`, graded at [mapping.ts:419](lib/epicor/mapping.ts#L419)).
  Text-only means vehicle matching becomes fuzzy string work — worth raising
  before the schema is signed off. *The fixtures grade `aces`; the real feed
  is unconfirmed.*
- **Are the portal's endpoints the supported API surface?** Portal-internal
  endpoints can change without notice and may not be covered by the licence for
  programmatic use. Fine for unblocking the pilot; confirm before it becomes
  production middleware.
- **Catalog size.** Deferred to "determine from Pilot", so the full-CCL
  architecture is still unsized. This drives the queue and worker decisions below.

---

## Shopify setup

One-time, in the store admin:

1. **Settings → Apps and sales channels → Develop apps → Create an app.**
   Scopes: `write_products`, `read_products`, `write_files`, `read_files`.
   Install, then copy the Admin API access token (`shpat_…`) into `.env`.
2. `npm run setup:metafields` ([metafields.ts:181](lib/shopify/metafields.ts#L181)) creates:
   - `epicor.part_key` — type **`id`**, *not* `single_line_text_field`. Shopify
     rejects `identifier.customId` against any other type with *"Metafield
     definition of type 'id' is required when using custom ids"*. The `id` type
     enables unique values by itself. `verify` asserts the type, because a wrong
     one only fails later, at push time.
   - `fitment.applications` — JSON
   - `fitment.summary` — multi-line text, human-readable vehicle list

Products are pushed as `DRAFT` and tagged `epicor-pilot`, so nothing reaches
the storefront and the whole pilot is reversible:

```bash
npm run reset:pilot -- --shopify   # deletes only tagged products
```

No theme work is needed. Fitment lands in metafields, visible on the product
page in the admin. Rendering it on the storefront is a later phase.

---

## Commands

| Command | What it does |
|---|---|
| `npm run verify` | Env, DB, Shopify auth, metafield definitions — 13 checks |
| `npm run setup:metafields` | Create the metafield definitions (idempotent) |
| `npm run sync` | Full pipeline |
| `npm run sync:extract` | Epicor → `raw_payload` only |
| `npm run sync:normalize` | `raw_payload` → normalized tables only |
| `npm run sync:push` | Normalized tables → Shopify only |
| `npm run prove` | Three-run idempotency assertions |
| `npm run reset:pilot` | Truncate local tables (`-- --shopify` also deletes tagged products) |
| `npm run dev` | Console UI |
| `npm run typecheck` | `tsc --noEmit` |

`GET /api/products` ([route.ts](app/api/products/route.ts)) returns everything
the pilot captured as one JSON payload — useful for a demo or for attaching to
a sign-off email.

---

## Trial → production

What changes between 5 parts and the full licensed CCL. The important point:
**none of it touches the mapping or hashing logic.** The stage boundaries and
the landing table are what make each of these an additive change.

| # | Today | For the full CCL | Touches |
|---|---|---|---|
| 1 | Extractor reads the first page only | Follow the API's paging cursor | [extract.ts:19](lib/sync/extract.ts#L19), [endpoints.ts:78](lib/epicor/endpoints.ts#L78) already sends a page size |
| 2 | Sequential push loop, one product at a time | Queue + worker pool | [push.ts:32](lib/sync/push.ts#L32) — the loop body is already independent per product |
| 3 | Manual CLI trigger | Scheduler: catalog daily, price/inventory hourly, interval configurable | New cron/queue around [run.ts:22](lib/sync/run.ts#L22) |
| 4 | Fitment in metafields | Metaobjects or a dedicated fitment app | `fitment` table [schema.ts:100](db/schema.ts#L100) is already normalized — a new writer, not a new schema |
| 5 | No price/inventory | EPN endpoint + columns, switchable on Live credentials | New `ENDPOINTS` entry + `product` columns |
| 6 | Fitment invisible to shoppers | Year → Make → Model → Submodel/Engine storefront search | New phase: metaobjects, search index, theme work |
| 7 | Full catalog pass each run | Delta sync on changed parts only | `source_hash` [normalize.ts:105](lib/sync/normalize.ts#L105) already does this locally; needs a "changed since" parameter on the Epicor side to avoid re-fetching |

**Already production-shaped, not pilot-shaped:**

- Rate limiting is cost-aware — it waits for Shopify's bucket to refill based
  on the reported `restoreRate` rather than retrying blindly
  ([client.ts:74](lib/shopify/client.ts#L74)).
- `userErrors` are treated as failures ([client.ts:109](lib/shopify/client.ts#L109)).
  Ignoring those is how syncs "succeed" while writing nothing.
- Every run and per-product outcome is recorded in `sync_run` / `sync_event`,
  so a failed product at CCL scale is one query away rather than a log grep.
- `raw_payload` means a mapping bug is a re-run of normalize, not a re-fetch of
  the catalog.

**Sizing caveats worth stating to the client:**

- A part with tens of thousands of applications will exceed practical metafield
  size. Postgres stays authoritative; item 4 above is the answer.
- Shopify plan behaviour changes significantly past roughly 50k products, and
  the plan is a normal Shopify plan, not Plus. Worth confirming the real catalog
  size (open question above) before committing to a target architecture.
- Fixtures use fictional brands and part numbers. They exist to prove the flow,
  not to represent real catalog content — replace with captured payloads before
  demoing data accuracy.

---

## Notes

- `SHOPIFY_API_VERSION` is pinned (`2026-07`). Don't use `latest`; Shopify ships
  breaking changes quarterly.
- **`part_key` is never sent in the `productSet` input.** It carries a uniqueness
  constraint, and `productSet` rejects a value already assigned — including the
  product's own — with *"Value is already assigned to another metafield"*.
  Shopify sets it from `identifier.customId` on create, so writing it inline is
  redundant as well as fatal. `upsertProduct` reads the metafield back off the
  `productSet` response and only issues a `metafieldsSet` when it is genuinely
  absent, which is normally never — [products.ts:287](lib/shopify/products.ts#L287).
- `productSet` also rejects the *fitment* metafields in some cases when
  identifying by `customId`. [products.ts:204](lib/shopify/products.ts#L204)
  detects that and falls back to a separate `metafieldsSet` call.
- The `part_key` metafield type is read from `DEFINITIONS`
  ([metafields.ts:13](lib/shopify/metafields.ts#L13)) rather than hardcoded at
  the write site ([products.ts:11](lib/shopify/products.ts#L11)). Those two
  drifted apart once already, and the symptom — every write failing with
  *"Type '...' must be consistent with the definition's type"* — showed up only
  at push time.
- `setup:metafields` recreates a definition whose type is wrong, since Shopify
  cannot alter a type in place. It refuses when products already hold values for
  it ([metafields.ts:227](lib/shopify/metafields.ts#L227)), because dropping the
  definition drops their `part_key`s with it.
