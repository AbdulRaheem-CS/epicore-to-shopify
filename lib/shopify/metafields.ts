import { METAFIELDS } from "@/lib/env";
import { shopifyGraphQL } from "./client";

interface DefinitionSpec {
  namespace: string;
  key: string;
  name: string;
  type: string;
  description: string;
  uniqueValues?: boolean;
}

export const DEFINITIONS: DefinitionSpec[] = [
  {
    ...METAFIELDS.partKey,
    name: "Epicor part key",
    // MUST be "id", not single_line_text_field. Shopify rejects
    // identifier.customId against any other type with "Metafield definition
    // of type 'id' is required when using custom ids." The id type also turns
    // uniqueValues on by itself, so the capability need not be requested.
    type: "id",
    description:
      "Brand + part number, e.g. NORTHLINE::NF-51515. Used as the upsert " +
      "identifier so re-running the sync never creates a duplicate.",
    uniqueValues: true,
  },
  {
    ...METAFIELDS.fitment,
    name: "Vehicle fitment",
    type: "json",
    description: "ACES-derived vehicle applications for this part.",
  },
  {
    ...METAFIELDS.fitmentText,
    name: "Fitment summary",
    type: "multi_line_text_field",
    description: "Human-readable vehicle list, one application per line.",
  },
];

const CREATE = /* GraphQL */ `
  mutation CreateDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition {
        id
        namespace
        key
        type {
          name
        }
        capabilities {
          uniqueValues {
            enabled
            eligible
          }
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const LIST = /* GraphQL */ `
  query Definitions($namespace: String!) {
    metafieldDefinitions(
      first: 25
      ownerType: PRODUCT
      namespace: $namespace
    ) {
      nodes {
        id
        namespace
        key
        metafieldsCount
        type {
          name
        }
        capabilities {
          uniqueValues {
            enabled
            eligible
          }
        }
      }
    }
  }
`;

const DELETE = /* GraphQL */ `
  mutation DeleteDefinition($id: ID!) {
    metafieldDefinitionDelete(id: $id, deleteAllAssociatedMetafields: true) {
      deletedDefinitionId
      userErrors {
        field
        message
        code
      }
    }
  }
`;

interface DefinitionNode {
  id: string;
  namespace: string;
  key: string;
  metafieldsCount?: number;
  type: { name: string };
  capabilities: { uniqueValues: { enabled: boolean; eligible: boolean } };
}

export async function listDefinitions(namespace: string) {
  const data = await shopifyGraphQL<{
    metafieldDefinitions: { nodes: DefinitionNode[] };
  }>(LIST, { namespace });
  return data.metafieldDefinitions.nodes;
}

export interface EnsureResult {
  namespace: string;
  key: string;
  status: "created" | "exists" | "recreated" | "failed";
  type?: string;
  uniqueValues?: boolean;
  message?: string;
}

function inputFor(spec: DefinitionSpec): Record<string, unknown> {
  const definition: Record<string, unknown> = {
    name: spec.name,
    namespace: spec.namespace,
    key: spec.key,
    description: spec.description,
    type: spec.type,
    ownerType: "PRODUCT",
    pin: true,
  };
  if (spec.uniqueValues) {
    definition.capabilities = { uniqueValues: { enabled: true } };
  }
  return definition;
}

async function createDefinition(spec: DefinitionSpec) {
  const data = await shopifyGraphQL<{
    metafieldDefinitionCreate: {
      createdDefinition: DefinitionNode | null;
      userErrors: Array<{ field?: string[]; message: string; code?: string }>;
    };
  }>(CREATE, { definition: inputFor(spec) });
  return data.metafieldDefinitionCreate;
}

async function deleteDefinition(id: string) {
  const data = await shopifyGraphQL<{
    metafieldDefinitionDelete: {
      deletedDefinitionId: string | null;
      userErrors: Array<{ field?: string[]; message: string; code?: string }>;
    };
  }>(DELETE, { id });
  const errors = data.metafieldDefinitionDelete.userErrors;
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
}

/**
 * Idempotent: safe to run repeatedly. TAKEN errors mean the definition is
 * already there, which is a success for our purposes.
 *
 * The exception is a definition that exists with the WRONG type. Shopify
 * cannot change a definition's type in place, and a part_key that is not of
 * type "id" makes the whole customId upsert fail — so it is deleted and
 * recreated. That is gated on metafieldsCount being 0: once products carry
 * values, dropping the definition would drop their part_keys with it, and
 * the next sync would no longer recognise them.
 */
export async function ensureDefinitions(): Promise<EnsureResult[]> {
  const results: EnsureResult[] = [];

  for (const spec of DEFINITIONS) {
    try {
      const payload = await createDefinition(spec);
      const taken = payload.userErrors.some((e) => e.code === "TAKEN");

      if (payload.createdDefinition) {
        results.push({
          namespace: spec.namespace,
          key: spec.key,
          status: "created",
          type: payload.createdDefinition.type?.name,
          uniqueValues:
            payload.createdDefinition.capabilities?.uniqueValues?.enabled,
        });
        continue;
      }

      if (!taken) {
        results.push({
          namespace: spec.namespace,
          key: spec.key,
          status: "failed",
          message: payload.userErrors.map((e) => e.message).join("; "),
        });
        continue;
      }

      const existing = (await listDefinitions(spec.namespace)).find(
        (d) => d.key === spec.key,
      );

      if (!existing || existing.type.name === spec.type) {
        results.push({
          namespace: spec.namespace,
          key: spec.key,
          status: "exists",
          type: existing?.type.name,
          uniqueValues: existing?.capabilities?.uniqueValues?.enabled,
        });
        continue;
      }

      // Wrong type. Unusable as-is, and not alterable in place.
      const inUse = existing.metafieldsCount ?? 0;
      if (inUse > 0) {
        results.push({
          namespace: spec.namespace,
          key: spec.key,
          status: "failed",
          type: existing.type.name,
          message:
            `exists as "${existing.type.name}", needs "${spec.type}", and ` +
            `${inUse} product(s) already hold values. Clear them first ` +
            `(npm run reset:pilot -- --shopify) then re-run, or delete the ` +
            `definition in Settings > Custom data > Products.`,
        });
        continue;
      }

      await deleteDefinition(existing.id);
      const retry = await createDefinition(spec);
      if (retry.createdDefinition) {
        results.push({
          namespace: spec.namespace,
          key: spec.key,
          status: "recreated",
          type: retry.createdDefinition.type?.name,
          uniqueValues:
            retry.createdDefinition.capabilities?.uniqueValues?.enabled,
          message: `was "${existing.type.name}"`,
        });
      } else {
        results.push({
          namespace: spec.namespace,
          key: spec.key,
          status: "failed",
          message: retry.userErrors.map((e) => e.message).join("; "),
        });
      }
    } catch (err) {
      results.push({
        namespace: spec.namespace,
        key: spec.key,
        status: "failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
