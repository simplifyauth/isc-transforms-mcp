// src/util/diff.ts
import * as fjp from "fast-json-patch";

/**
 * ESM-safe "compare" extraction.
 * Some builds expose compare as named export, others hang it off default.
 */
function getCompare(): (a: any, b: any) => any[] {
  const anyMod = fjp as any;
  return (
    anyMod.compare ||
    anyMod.default?.compare ||
    (() => {
      throw new Error(
        "fast-json-patch: compare() not found. Check installed version."
      );
    })
  );
}

const compare = getCompare();

/**
 * Returns JSON Patch ops from before -> after (safe for null/undefined).
 */
export function jsonPatch(before: any, after: any): any[] {
  const a = before ?? {};
  const b = after ?? {};
  return compare(a, b);
}
