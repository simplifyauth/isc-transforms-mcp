// src/transforms/normalize.ts
import type { TransformSpec, TransformType } from "./catalog.js";
import { getTransformSpec, toCanonicalType } from "./catalog.js";

/**
 * Normalizes a transform "request shape" into the payload shape expected by the ISC Transform API.
 *
 * Important:
 * - Rule-backed operations (e.g., generateRandomString) are normalized to payload type "rule"
 *   with locked `attributes.name = "Cloud Services Deployment Utility"` and `attributes.operation = <op>`.
 */
type NormalizeOpts = {
  /**
   * When true, we are normalizing a transform object that appears *nested* inside another transform's attributes.
   * Nested transforms in ISC examples typically omit top-level fields like `name` and `internal`.
   * We therefore avoid auto-injecting synthetic values (e.g., "Transform-<type>") unless explicitly provided.
   */
  nested?: boolean;
};

export function normalizeTransform(input: any, opts: NormalizeOpts = {}): any {
  if (!input || typeof input !== "object") {
    throw new Error("Transform must be a JSON object.");
  }

  const requestedType = toCanonicalType(String(input.type || ""));
  if (!requestedType) {
    throw new Error(`Unknown transform type: ${String(input.type)}`);
  }

  const spec: TransformSpec | undefined = getTransformSpec(requestedType);
  if (!spec) {
    throw new Error(`No transform spec found for type: ${requestedType}`);
  }

  // NOTE: top-level transform objects require a name. Nested transforms typically do not.
  const name = String(input.name || input.id || (opts.nested ? "" : `Transform-${requestedType}`));

  // Ensure attributes object exists where required.
  const incomingAttrs: Record<string, any> =
    input.attributes && typeof input.attributes === "object" ? { ...input.attributes } : {};

  // Rule-backed operation keys are emitted as `{ type: "rule", attributes: { name, operation, ... } }`
  if (requestedType === "generateRandomString" || requestedType === "getEndOfString" || requestedType === "getReferenceIdentityAttribute") {
    const injected = spec.injectedAttributes || {};
    const lockedName = injected.name;
    const lockedOp = injected.operation;

    // Allow caller to provide other keys, but lock name/operation to the doc-required values.
    const merged = { ...incomingAttrs, ...injected };
    if (lockedName) merged.name = lockedName;
    if (lockedOp) merged.operation = lockedOp;

    const out: any = {
      // payload type
      type: "rule",
      ...(name ? { name } : {}),
      // only include internal when explicitly provided for nested; default false for top-level
      ...(opts.nested ? (input.internal !== undefined ? { internal: input.internal } : {}) : { internal: input.internal ?? false }),
      attributes: merged,
    };

    // If this is a top-level transform and name is missing, enforce.
    if (!opts.nested && !out.name) {
      throw new Error("Transform.name is required.");
    }
    return out;
  }

  // Standard transform payload
  const normalized: any = {
    type: requestedType,
    ...(name ? { name } : {}),
    ...(opts.nested ? (input.internal !== undefined ? { internal: input.internal } : {}) : { internal: input.internal ?? false }),
  };

  if (!opts.nested && !normalized.name) {
    throw new Error("Transform.name is required.");
  }

  if (!spec.attributesOptional) {
    normalized.attributes = incomingAttrs;
  } else if (Object.keys(incomingAttrs).length > 0) {
    normalized.attributes = incomingAttrs;
  }

  return normalized;
}

/**
 * Best-effort normalization for nested transform objects inside attributes:
 * - If an attribute value looks like a nested transform `{ type, attributes }`, normalize it recursively.
 */
export function deepNormalizeTransform(input: any): any {
  // Top-level normalization.
  const normalized = normalizeTransform(input, { nested: false });
  if (!normalized.attributes || typeof normalized.attributes !== "object") return normalized;

  const walk = (v: any): any => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      if (typeof v.type === "string") {
        try {
          // Nested normalization: do not inject synthetic name/internal.
          const n = normalizeTransform(v, { nested: true });
          if (!n.attributes || typeof n.attributes !== "object") return n;
          // Recurse into nested attributes.
          n.attributes = walk(n.attributes);
          return n;
        } catch {
          // not a known transform object; fall through
        }
      }
      const out: any = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };

  normalized.attributes = walk(normalized.attributes);
  return normalized;
}
