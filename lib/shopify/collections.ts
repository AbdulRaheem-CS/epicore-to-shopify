import { eq } from "drizzle-orm";
import { db } from "@/db";
import { shopifyCollection } from "@/db/schema";
import { assertNoUserErrors, shopifyGraphQL } from "./client";

const COLLECTION_FIELDS = /* GraphQL */ `
  id
  title
  handle
`;

const BY_HANDLE = /* GraphQL */ `
  query CollectionByHandle($handle: String!) {
    collectionByHandle(handle: $handle) {
      ${COLLECTION_FIELDS}
    }
  }
`;

const CREATE = /* GraphQL */ `
  mutation CreateCollection($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection {
        ${COLLECTION_FIELDS}
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface CollectionNode {
  id: string;
  title: string;
  handle: string;
}

/**
 * Shopify derives a handle from the title, and handles are unique per store.
 * Deriving it the same way ourselves is what lets us look a collection up
 * before trying to create it, and it is why "Ignition & Engine Filters"
 * resolves to the same collection on every run.
 */
export function collectionHandle(title: string): string {
  return title
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 255);
}

/** In-process cache, so one sync run resolves each collection once. */
const cache = new Map<string, string>();

/**
 * Returns the Shopify GID for a collection of this title, creating it if it
 * does not exist yet.
 *
 * Three layers, cheapest first: the per-run cache, then our own
 * shopify_collection table, then Shopify itself. Only a genuinely new
 * category costs a create. A collection deleted in the admin is detected by
 * the handle lookup and recreated, so the local table can never go stale.
 */
export async function ensureCollection(
  title: string,
  level: string,
): Promise<string> {
  const clean = title.trim();
  const cached = cache.get(clean);
  if (cached) return cached;

  const handle = collectionHandle(clean);

  // Shopify is the authority — check it before trusting our own record, so a
  // collection removed in the admin gets recreated rather than silently
  // dropping every product assignment.
  const existing = await shopifyGraphQL<{
    collectionByHandle: CollectionNode | null;
  }>(BY_HANDLE, { handle });

  if (existing.collectionByHandle) {
    const gid = existing.collectionByHandle.id;
    await remember(clean, level, gid);
    cache.set(clean, gid);
    return gid;
  }

  const created = await shopifyGraphQL<{
    collectionCreate: {
      collection: CollectionNode | null;
      userErrors: Array<{ field?: string[]; message: string }>;
    };
  }>(CREATE, {
    input: {
      title: clean,
      handle,
      descriptionHtml: `Epicor ${level}: ${clean}`,
    },
  });
  assertNoUserErrors(created.collectionCreate, "collectionCreate");

  const gid = created.collectionCreate.collection!.id;
  await remember(clean, level, gid);
  cache.set(clean, gid);
  return gid;
}

async function remember(title: string, level: string, gid: string) {
  await db
    .insert(shopifyCollection)
    .values({ title, level, shopifyCollectionGid: gid })
    .onConflictDoUpdate({
      target: shopifyCollection.title,
      set: { level, shopifyCollectionGid: gid },
    });
}

/** Used by reset:pilot and the console. */
export async function listKnownCollections() {
  return db.select().from(shopifyCollection).orderBy(shopifyCollection.title);
}

export async function forgetCollection(title: string) {
  await db.delete(shopifyCollection).where(eq(shopifyCollection.title, title));
}
