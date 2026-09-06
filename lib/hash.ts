import { createHash } from "node:crypto";

/**
 * Order-independent, key-sorted digest. Two structurally identical objects
 * always hash the same, so the delta check never fires on key reordering
 * from the upstream API.
 */
export function stableHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function shortHash(value: unknown): string {
  return stableHash(value).slice(0, 12);
}

function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map(canonical).sort().join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}
