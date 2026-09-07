import { METAFIELDS, env } from "@/lib/env";
import { ShopifyError, assertNoUserErrors, shopifyGraphQL } from "./client";
import { DEFINITIONS } from "./metafields";

/**
 * Read from the same specs setup:metafields creates, so the two can never
 * disagree. They did: this was hardcoded to single_line_text_field while the
 * definition needed "id", and metafieldsSet rejected every write with
 * "Type '...' must be consistent with the definition's type".
 */
const PART_KEY_TYPE =
  DEFINITIONS.find((d) => d.key === METAFIELDS.partKey.key)?.type ?? "id";

export interface ProductUpsertInput {
  partKey: string;
  /** Brand-qualified, so it is unique across manufacturers. */
  sku: string;
  title: string;
  descriptionHtml: string | null;
  vendor: string;
  productType: string | null;
  /** UPC → Shopify's native variant barcode field. */
  barcode: string | null;
  /** Shipping weight → the variant's inventory item measurement. */
  weight: number | null;
  weightUnit: string | null;
  /** Collection GIDs this product belongs to. */
  collections: string[];
  fitmentJson: unknown;
  fitmentSummary: string;
}

export interface ProductUpsertResult {
  productGid: string;
  variantGid: string | null;
  action: "created" | "updated";
}

const PRODUCT_FIELDS = /* GraphQL */ `
  id
  title
  handle
  status
  variants(first: 1) {
    nodes {
      id
      sku
    }
  }
  partKey: metafield(namespace: "${METAFIELDS.partKey.namespace}", key: "${METAFIELDS.partKey.key}") {
    value
  }
`;

const BY_IDENTIFIER = /* GraphQL */ `
  query ProductByPartKey($identifier: ProductIdentifierInput!) {
    productByIdentifier(identifier: $identifier) {
      ${PRODUCT_FIELDS}
    }
  }
`;

const PRODUCT_SET = /* GraphQL */ `
  mutation UpsertProduct(
    $input: ProductSetInput!
    $identifier: ProductSetIdentifiers
  ) {
    productSet(input: $input, identifier: $identifier, synchronous: true) {
      product {
        ${PRODUCT_FIELDS}
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const METAFIELDS_SET = /* GraphQL */ `
  mutation SetMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface ProductNode {
  id: string;
  title: string;
  handle: string;
  status: string;
  variants: { nodes: Array<{ id: string; sku: string | null }> };
  partKey: { value: string } | null;
}

/**
 * Looks a product up by the epicor.part_key metafield. This is the check
 * that catches a product already sitting in the store from a previous run,
 * a restored database snapshot, or a manual entry — the exact conditions
 * under which a naive sync creates a second copy.
 */
export async function findProductByPartKey(
  partKey: string,
): Promise<ProductNode | null> {
  try {
    const data = await shopifyGraphQL<{
      productByIdentifier: ProductNode | null;
    }>(BY_IDENTIFIER, {
      identifier: {
        customId: {
          namespace: METAFIELDS.partKey.namespace,
          key: METAFIELDS.partKey.key,
          value: partKey,
        },
      },
    });
    return data.productByIdentifier;
  } catch (err) {
    // Never let a lookup failure become a duplicate. Bubble it up so the
    // caller records a failed event instead of blindly creating.
    throw new ShopifyError(
      `Could not look up part_key "${partKey}". Confirm the epicor.part_key ` +
        `metafield definition exists with unique values enabled ` +
        `(npm run setup:metafields). Original: ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
  }
}

export async function upsertProduct(
  input: ProductUpsertInput,
  knownGid?: string | null,
): Promise<ProductUpsertResult> {
  const existingGid = knownGid ?? (await findProductByPartKey(input.partKey))?.id ?? null;

  const productInput: Record<string, unknown> = {
    title: input.title,
    descriptionHtml: input.descriptionHtml ?? "",
    vendor: input.vendor,
    productType: input.productType ?? "",
    status: env.SHOPIFY_PRODUCT_STATUS,
    tags: [env.SHOPIFY_PILOT_TAG, input.vendor].filter(Boolean),
    // Single-variant product: productSet still wants an explicit option.
    productOptions: [
      { name: "Title", values: [{ name: "Default Title" }] },
    ],
    variants: [buildVariant(input)],
  };

  // productSet replaces the collection set it is given, so only send the key
  // when we actually resolved collections — otherwise a run with collections
  // disabled would strip a product out of every collection it is in.
  if (input.collections.length) {
    productInput.collections = input.collections;
  }

  const metafields = fitmentMetafields(input);

  // Path 1 — we know the Shopify id, so update in place.
  if (existingGid) {
    const product = await runProductSet(
      { ...productInput, metafields },
      { id: existingGid },
      input,
    );
    await ensurePartKey(product, input.partKey);
    return {
      productGid: product.id,
      variantGid: product.variants.nodes[0]?.id ?? null,
      action: "updated",
    };
  }

  // Path 2 — create, keyed on part_key so a concurrent or repeated run
  // resolves to the same product rather than a second one.
  const product = await runProductSet(
    { ...productInput, metafields },
    {
      customId: {
        namespace: METAFIELDS.partKey.namespace,
        key: METAFIELDS.partKey.key,
        value: input.partKey,
      },
    },
    input,
  );

  await ensurePartKey(product, input.partKey);

  return {
    productGid: product.id,
    variantGid: product.variants.nodes[0]?.id ?? null,
    action: "created",
  };
}

/**
 * There is a known issue where productSet rejects metafields in the input
 * when identifying by customId. If that happens, retry without them and
 * write the metafields immediately afterwards — the part_key MUST land, or
 * the next run will not recognise this product and will create a duplicate.
 */
async function runProductSet(
  productInput: Record<string, unknown>,
  identifier: Record<string, unknown>,
  input: ProductUpsertInput,
): Promise<ProductNode> {
  try {
    const data = await shopifyGraphQL<{
      productSet: { product: ProductNode; userErrors: Array<{ field?: string[]; message: string }> };
    }>(PRODUCT_SET, { input: productInput, identifier });
    assertNoUserErrors(data.productSet, "productSet");
    return data.productSet.product;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const metafieldIssue = /metafield/i.test(message);
    if (!metafieldIssue || !("metafields" in productInput)) throw err;

    const { metafields: _dropped, ...withoutMetafields } = productInput;
    const data = await shopifyGraphQL<{
      productSet: { product: ProductNode; userErrors: Array<{ field?: string[]; message: string }> };
    }>(PRODUCT_SET, { input: withoutMetafields, identifier });
    assertNoUserErrors(data.productSet, "productSet (metafield fallback)");

    const product = data.productSet.product;
    await setProductMetafields(product.id, input);
    return product;
  }
}

/**
 * barcode and weight are only sent when Epicor actually supplied them.
 * Writing `null` would clear a value a merchant had set by hand, and writing
 * a zero weight is worse than writing none at all.
 */
function buildVariant(input: ProductUpsertInput): Record<string, unknown> {
  const variant: Record<string, unknown> = {
    sku: input.sku,
    optionValues: [{ optionName: "Title", name: "Default Title" }],
  };

  if (input.barcode) variant.barcode = input.barcode;

  if (input.weight !== null && input.weight > 0) {
    variant.inventoryItem = {
      measurement: {
        weight: {
          value: input.weight,
          unit: input.weightUnit ?? "POUNDS",
        },
      },
    };
  }

  return variant;
}

/**
 * Fitment only. part_key is deliberately excluded from the productSet input:
 * it carries a uniqueness constraint, and productSet rejects a value that is
 * already assigned — including the product's own — with "Value is already
 * assigned to another metafield". Shopify sets it from identifier.customId on
 * create anyway, so writing it inline is both redundant and fatal.
 */
function fitmentMetafields(input: ProductUpsertInput) {
  return [
    {
      namespace: METAFIELDS.fitment.namespace,
      key: METAFIELDS.fitment.key,
      type: "json",
      value: JSON.stringify(input.fitmentJson ?? []),
    },
    {
      namespace: METAFIELDS.fitmentText.namespace,
      key: METAFIELDS.fitmentText.key,
      type: "multi_line_text_field",
      value: input.fitmentSummary,
    },
  ];
}

async function metafieldsSet(
  productGid: string,
  metafields: Array<Record<string, unknown>>,
  label: string,
) {
  const data = await shopifyGraphQL<{
    metafieldsSet: {
      metafields: Array<{ id: string }>;
      userErrors: Array<{ field?: string[]; message: string }>;
    };
  }>(METAFIELDS_SET, {
    metafields: metafields.map((m) => ({ ...m, ownerId: productGid })),
  });
  assertNoUserErrors(data.metafieldsSet, label);
  return data.metafieldsSet.metafields;
}

export async function setProductMetafields(
  productGid: string,
  input: ProductUpsertInput,
) {
  return metafieldsSet(productGid, fitmentMetafields(input), "metafieldsSet");
}

/**
 * The part_key has to be on the product or the next run cannot recognise it
 * and Shopify would create a second one. customId sets it on create and an
 * updated product already carries it, so this is normally a no-op — but the
 * productSet response is checked rather than assumed, because the one path
 * that can miss it is an update against a Shopify id cached in shopify_map.
 */
async function ensurePartKey(product: ProductNode, partKey: string) {
  if (product.partKey?.value === partKey) return;
  await metafieldsSet(
    product.id,
    [
      {
        namespace: METAFIELDS.partKey.namespace,
        key: METAFIELDS.partKey.key,
        type: PART_KEY_TYPE,
        value: partKey,
      },
    ],
    "metafieldsSet (part_key)",
  );
}

/**
 * Shopify caps the cost of a nodes() query, so ask in batches rather than
 * one call with every mapped id.
 */
const EXISTS_CHUNK = 100;

const NODES = /* GraphQL */ `
  query CheckProductsExist($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
      }
    }
  }
`;

/**
 * Which of these product GIDs no longer exist in Shopify.
 *
 * nodes() returns null in place of anything deleted, which is the only cheap
 * way to ask "is our local map still true?" in bulk — one request per 100
 * mapped products rather than one per product.
 */
export async function findMissingProducts(
  gids: string[],
): Promise<Set<string>> {
  const missing = new Set<string>();

  for (let i = 0; i < gids.length; i += EXISTS_CHUNK) {
    const chunk = gids.slice(i, i + EXISTS_CHUNK);
    const data = await shopifyGraphQL<{
      nodes: Array<{ id: string } | null>;
    }>(NODES, { ids: chunk });
    chunk.forEach((gid, index) => {
      if (!data.nodes[index]) missing.add(gid);
    });
  }

  return missing;
}

/** Used by the proof script to assert nothing duplicated. */
export async function countPilotProducts() {
  const data = await shopifyGraphQL<{
    productsCount: { count: number };
  }>(
    /* GraphQL */ `
      query CountPilot($query: String) {
        productsCount(query: $query) {
          count
        }
      }
    `,
    { query: `tag:${env.SHOPIFY_PILOT_TAG}` },
  );
  return data.productsCount.count;
}
