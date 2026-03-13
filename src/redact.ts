const SECRET_KEYS = new Set([
  "authorization",
  "access_token",
  "refresh_token",
  "client_secret",
  "secret",
  "token"
]);

export function redactDeep<T>(obj: T): T {
  return redactAny(obj) as T;
}

function redactAny(v: any): any {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(redactAny);
  if (typeof v === "object") {
    const out: any = {};
    for (const [k, val] of Object.entries(v)) {
      if (SECRET_KEYS.has(k.toLowerCase())) out[k] = "***REDACTED***";
      else out[k] = redactAny(val);
    }
    return out;
  }
  return v;
}
