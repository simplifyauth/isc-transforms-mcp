import type { Config } from "../config.js";
import type { HttpMethod } from "../allowlist.js";
import { isAllowed } from "../allowlist.js";
import { HttpError } from "./errors.js";
import { getBearerToken } from "./iscAuth.js";

function stripTrailingSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

function stripLeadingSlash(p: string): string {
  return p.replace(/^\/+/, "");
}

export class IScClient {
  private baseUrl: string;        // e.g. https://{tenant}.api.identitynow.com
  private defaultVersion: string; // e.g. v3
  private baseApi: string;        // e.g. https://{tenant}.api.identitynow.com/v3

  constructor(private cfg: Config) {
    this.baseUrl = stripTrailingSlash(cfg.apiBaseUrl);
    this.defaultVersion = stripLeadingSlash(cfg.apiVersion);
    this.baseApi = `${this.baseUrl}/${this.defaultVersion}`;
  }

  /** Backwards-compatible (default version). */
  public getBaseApi(): string {
    return this.baseApi;
  }

  /** Version-aware base. */
  public getBaseApiFor(version: string): string {
    return `${this.baseUrl}/${stripLeadingSlash(version)}`;
  }

  /** Default-version request (existing code uses this). */
  async request<T>(
    method: HttpMethod,
    path: string,
    body?: any,
    extraHeaders?: Record<string, string>
  ): Promise<T> {
    return this.requestWithVersion<T>(this.defaultVersion, method, path, body, extraHeaders);
  }

  /**
   * Version-aware request.
   * Example:
   *  - version="v3", path="/workflows"
   *  - version="v2024", path="/form-definitions"
   */
  async requestWithVersion<T>(
    version: string,
    method: HttpMethod,
    path: string, // "/transforms?limit=50" or "transforms?limit=50"
    body?: any,
    extraHeaders?: Record<string, string>
  ): Promise<T> {
    const v = stripLeadingSlash(version);
    const fullPath = `/${stripLeadingSlash(path)}`; // "/transforms?limit=50"
    const allowPath = `/${v}${fullPath}`;           // "/v3/transforms?limit=50"

    if (!isAllowed(this.cfg.mode, method, allowPath)) {
      throw new Error(`Blocked by allowlist: ${method} ${allowPath} (mode=${this.cfg.mode})`);
    }

    const token = await getBearerToken(this.cfg);
    const url = `${this.baseUrl}/${v}${fullPath}`;

    const resp = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(extraHeaders || {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.cfg.timeoutMs)
    });

    const text = await resp.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* ignore */
    }

    if (!resp.ok) {
      throw new HttpError(`ISC API failed (${resp.status}) ${method} /${v}${fullPath}`, resp.status, json ?? text);
    }

    return (json ?? (text as any)) as T;
  }
}
