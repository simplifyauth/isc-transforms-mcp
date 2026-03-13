import "dotenv/config";

export type McpMode = "readonly" | "write";

export type LicenseTier = "personal" | "enterprise";

export type Config = {
  tenant?: string;
  apiBaseUrl: string;
  apiVersion: string;
  mode: McpMode;
  debug: boolean;
  timeoutMs: number;
  accessToken?: string;
  patClientId?: string;
  patClientSecret?: string;
  /** true when no ISC credentials were provided — Phase 1 (offline) tools only */
  offline: boolean;
  /** License key supplied via ISC_MCP_LICENSE_KEY — required for Phase 2 (enterprise) tools */
  licenseKey?: string;
  /** Resolved tier: personal (no key) or enterprise (valid key present) */
  licenseTier: LicenseTier;
};

function mustBool(v: string | undefined, def: boolean): boolean {
  if (!v) return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function mustInt(v: string | undefined, def: number): number {
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function stripTrailingSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

/**
 * Validates the license key format: ISC-XXXX-XXXX-XXXX-XXXX
 * where each X is an uppercase alphanumeric character (A-Z0-9).
 * Full online activation is optional and handled separately at first use.
 */
export function isValidLicenseKey(key: string | undefined): boolean {
  if (!key) return false;
  return /^ISC-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(key);
}

export function loadConfig(): Config {
  const tenant = process.env.ISC_TENANT?.trim();
  const explicitBase = process.env.ISC_API_BASE_URL?.trim();

  let apiBaseUrl = explicitBase || "";
  if (!apiBaseUrl && tenant) {
    apiBaseUrl = `https://${tenant}.api.identitynow.com`;
  }
  apiBaseUrl = stripTrailingSlash(apiBaseUrl || "");

  const apiVersion = (process.env.ISC_API_VERSION?.trim() || "v3").replace(/^\/+/, "");
  const modeRaw = (process.env.ISC_MCP_MODE?.trim() || "readonly") as any;
  if (modeRaw !== "readonly" && modeRaw !== "write") {
    throw new Error("Config error: ISC_MCP_MODE must be 'readonly' or 'write'.");
  }

  const debug = mustBool(process.env.ISC_MCP_DEBUG, false);
  const timeoutMs = mustInt(process.env.ISC_TIMEOUT_MS, 30000);

  const accessToken = process.env.ISC_ACCESS_TOKEN?.trim();
  const patClientId = process.env.ISC_PAT_CLIENT_ID?.trim();
  const patClientSecret = process.env.ISC_PAT_CLIENT_SECRET?.trim();

  // Offline mode: no ISC credentials — Phase 1 tools work, Phase 2 tools will return a clear error.
  const offline = !accessToken && !(patClientId && patClientSecret);
  if (offline && !apiBaseUrl) {
    apiBaseUrl = "https://tenant.api.identitynow.com"; // placeholder, not used in offline mode
  }

  // License key — required for Phase 2 (enterprise) tools.
  // Format: ISC-XXXX-XXXX-XXXX-XXXX (groups of 4 uppercase alphanumeric, prefix ISC-)
  const licenseKey = process.env.ISC_MCP_LICENSE_KEY?.trim() || undefined;
  const licenseTier: LicenseTier = isValidLicenseKey(licenseKey) ? "enterprise" : "personal";

  return {
    tenant,
    apiBaseUrl,
    apiVersion,
    mode: modeRaw,
    debug,
    timeoutMs,
    accessToken,
    patClientId,
    patClientSecret,
    offline,
    licenseKey,
    licenseTier,
  };
}
