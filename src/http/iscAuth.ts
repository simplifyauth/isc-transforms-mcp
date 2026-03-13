import type { Config } from "../config.js";
import { HttpError } from "./errors.js";

type TokenCache = { token: string; expEpochMs: number };

let cache: TokenCache | null = null;

function nowMs(): number {
  return Date.now();
}

// Token URL example in v3 API intro: https://{tenant}.api.identitynow.com/oauth/token // Docs: https://developer.sailpoint.com/docs/api/v3/
export async function getBearerToken(cfg: Config): Promise<string> {
  // If user supplied a token, use it.
  if (cfg.accessToken) return cfg.accessToken;

  if (!cfg.patClientId || !cfg.patClientSecret) {
    throw new Error("Missing PAT credentials (ISC_PAT_CLIENT_ID / ISC_PAT_CLIENT_SECRET).");
  }

  // cache: refresh if expiring within 60s
  if (cache && cache.expEpochMs - nowMs() > 60_000) return cache.token;

  const tokenUrl = `${cfg.apiBaseUrl}/oauth/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: cfg.patClientId,
    client_secret: cfg.patClientSecret
  });

  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(cfg.timeoutMs)
  });

  const text = await resp.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }

  if (!resp.ok) {
    throw new HttpError(`Token request failed (${resp.status})`, resp.status, json ?? text);
  }

  const token = json?.access_token;
  const expiresIn = Number(json?.expires_in ?? 900);
  if (!token) {
    throw new Error("Token response missing access_token");
  }

  cache = { token, expEpochMs: nowMs() + expiresIn * 1000 };
  return token;
}
