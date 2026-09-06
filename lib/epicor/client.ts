import { readFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";
import { ENDPOINTS, type EndpointName, type EndpointSpec } from "./endpoints";

export interface EpicorResult {
  endpoint: EndpointName;
  params: Record<string, string>;
  body: unknown;
}

export class EpicorError extends Error {
  constructor(
    message: string,
    readonly endpoint: EndpointName,
    readonly status?: number,
  ) {
    super(message);
    this.name = "EpicorError";
  }
}

/**
 * Talks to the Epicor pilot catalog. In "fixtures" mode it reads saved JSON
 * from disk instead, so every stage downstream can be built and tested
 * before Epicor hands over the API contract.
 */
export class EpicorClient {
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private readonly mode = env.EPICOR_MODE) {}

  get isLive() {
    return this.mode === "live";
  }

  async call(
    name: EndpointName,
    params: Record<string, string> = {},
  ): Promise<EpicorResult> {
    const spec = ENDPOINTS[name];
    const body = this.isLive
      ? await this.requestLive(name, spec, params)
      : await this.readFixture(name, spec, params);
    return { endpoint: name, params, body };
  }

  // --- fixtures ------------------------------------------------------------

  /**
   * Looks for a per-part fixture first (part-detail.NF-51515.json) so each
   * product in the pilot set can have its own saved payload, then falls back
   * to the shared file.
   */
  private async readFixture(
    name: EndpointName,
    spec: EndpointSpec,
    params: Record<string, string> = {},
  ) {
    const suffix = params.partId ?? params.partNumber;
    const variants = suffix
      ? [spec.fixture.replace(/\.json$/, `.${suffix}.json`), spec.fixture]
      : [spec.fixture];

    const candidates = variants.flatMap((file) => [
      path.join(process.cwd(), "fixtures", "captured", file),
      path.join(process.cwd(), "fixtures", file),
    ]);
    for (const file of candidates) {
      try {
        return JSON.parse(await readFile(file, "utf8"));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    throw new EpicorError(
      `No fixture for "${name}". Expected one of:\n  ${candidates.join("\n  ")}`,
      name,
    );
  }

  // --- live ----------------------------------------------------------------

  private async requestLive(
    name: EndpointName,
    spec: EndpointSpec,
    params: Record<string, string>,
  ) {
    if (spec.placeholder && name !== "token") {
      throw new EpicorError(
        `Endpoint "${name}" is still a placeholder. Capture the real request ` +
          `in DevTools and update lib/epicor/endpoints.ts (see the header ` +
          `comment), or run with EPICOR_MODE=fixtures.`,
        name,
      );
    }

    const url = new URL(
      substitute(spec.path, params, name),
      env.EPICOR_BASE_URL,
    );
    for (const [k, v] of Object.entries(spec.query ?? {})) {
      url.searchParams.set(k, substitute(v, params, name));
    }
    // Any param not consumed by the path becomes a query param.
    for (const [k, v] of Object.entries(params)) {
      if (!spec.path.includes(`:${k}`) && !url.searchParams.has(k)) {
        url.searchParams.set(k, v);
      }
    }

    const headers: Record<string, string> = { Accept: "application/json" };
    if (name !== "token") {
      Object.assign(headers, await this.authHeaders(name));
    }

    let payload: string | undefined;
    if (spec.method === "POST" && spec.body) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(
        JSON.parse(substitute(JSON.stringify(spec.body), params, name)),
      );
    }

    const res = await fetch(url, {
      method: spec.method,
      headers,
      body: payload,
    });

    if (res.status === 401 || res.status === 403) {
      this.token = null;
      throw new EpicorError(
        `Epicor rejected the credentials (${res.status}). Check EPICOR_TOKEN ` +
          `or the auth header name captured from the portal.`,
        name,
        res.status,
      );
    }
    if (!res.ok) {
      throw new EpicorError(
        `${spec.method} ${url.pathname} failed: ${res.status} ${await res
          .text()
          .catch(() => "")}`.slice(0, 500),
        name,
        res.status,
      );
    }
    return res.json();
  }

  private async authHeaders(
    name: EndpointName,
  ): Promise<Record<string, string>> {
    const token = await this.ensureToken(name);
    switch (env.EPICOR_AUTH_STYLE) {
      case "apikey":
        return { "x-api-key": token };
      case "cookie":
        return { Cookie: token };
      case "bearer":
      default:
        return { Authorization: `Bearer ${token}` };
    }
  }

  private async ensureToken(name: EndpointName): Promise<string> {
    // A static key from .env wins — simplest case, no refresh needed.
    if (env.EPICOR_TOKEN) return env.EPICOR_TOKEN;

    if (this.token && Date.now() < this.tokenExpiresAt - 30_000) {
      return this.token;
    }
    if (!env.EPICOR_USERNAME || !env.EPICOR_PASSWORD) {
      throw new EpicorError(
        "No EPICOR_TOKEN and no EPICOR_USERNAME/PASSWORD to mint one.",
        name,
      );
    }

    const { body } = await this.call("token", {
      username: env.EPICOR_USERNAME,
      password: env.EPICOR_PASSWORD,
    });
    const record = body as Record<string, unknown>;
    const token = String(
      record.access_token ?? record.accessToken ?? record.token ?? "",
    );
    if (!token) {
      throw new EpicorError(
        `Token response had no recognisable token field. Keys: ${Object.keys(
          record,
        ).join(", ")}`,
        name,
      );
    }
    const ttl = Number(record.expires_in ?? record.expiresIn ?? 3600);
    this.token = token;
    this.tokenExpiresAt = Date.now() + ttl * 1000;
    return token;
  }
}

function substitute(
  template: string,
  params: Record<string, string>,
  endpoint: EndpointName,
): string {
  return template.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, key: string) => {
    const value = params[key];
    if (value === undefined) {
      throw new EpicorError(
        `Missing "${key}" for endpoint "${endpoint}".`,
        endpoint,
      );
    }
    return encodeURIComponent(value);
  });
}

export const epicor = new EpicorClient();
