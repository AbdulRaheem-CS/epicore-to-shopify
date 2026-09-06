import { env } from "@/lib/env";

export class ShopifyError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ShopifyError";
  }
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
  extensions?: {
    cost?: {
      requestedQueryCost: number;
      throttleStatus: {
        currentlyAvailable: number;
        maximumAvailable: number;
        restoreRate: number;
      };
    };
  };
}

const MAX_ATTEMPTS = 6;

/**
 * One entry point for every Admin API call. Handles the cost-based leaky
 * bucket: on THROTTLED, wait long enough for the bucket to refill rather
 * than hammering with a fixed retry.
 */
export async function shopifyGraphQL<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  if (!env.SHOPIFY_STORE || !env.SHOPIFY_TOKEN) {
    throw new ShopifyError(
      "SHOPIFY_STORE and SHOPIFY_TOKEN must be set in .env. Get the token " +
        "from Settings > Apps and sales channels > Develop apps > your app " +
        "> API credentials.",
    );
  }

  const url = `https://${env.SHOPIFY_STORE}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": env.SHOPIFY_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("Retry-After") ?? 0);
      await sleep(retryAfter ? retryAfter * 1000 : backoff(attempt));
      continue;
    }

    if (res.status === 401 || res.status === 403) {
      throw new ShopifyError(
        `Shopify rejected the token (${res.status}). Reinstall the custom ` +
          `app or check the access scopes.`,
      );
    }

    const json = (await res.json()) as GraphQLResponse<T>;

    const throttled = json.errors?.some(
      (e) => e.extensions?.code === "THROTTLED",
    );
    if (throttled) {
      const status = json.extensions?.cost?.throttleStatus;
      const needed = json.extensions?.cost?.requestedQueryCost ?? 100;
      const wait =
        status && status.restoreRate > 0
          ? ((needed - status.currentlyAvailable) / status.restoreRate) * 1000
          : backoff(attempt);
      await sleep(Math.max(500, Math.min(wait, 10_000)));
      continue;
    }

    if (json.errors?.length) {
      throw new ShopifyError(
        `GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`,
        json.errors,
      );
    }
    if (!json.data) {
      throw new ShopifyError("Shopify returned no data.", json);
    }
    return json.data;
  }

  throw new ShopifyError(
    `Gave up after ${MAX_ATTEMPTS} attempts (throttled or unavailable).`,
  );
}

/**
 * Shopify returns mutation failures inside userErrors with a 200 status.
 * Ignoring them is how syncs "succeed" while writing nothing.
 */
export function assertNoUserErrors(
  result: { userErrors?: Array<{ field?: string[] | null; message: string }> },
  context: string,
) {
  if (result.userErrors?.length) {
    throw new ShopifyError(
      `${context}: ${result.userErrors
        .map((e) => `${e.field?.join(".") ?? "-"} ${e.message}`)
        .join("; ")}`,
      result.userErrors,
    );
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt: number) =>
  Math.min(500 * 2 ** (attempt - 1), 8000) + Math.random() * 250;
